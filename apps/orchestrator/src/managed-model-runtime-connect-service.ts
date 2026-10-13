import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  LocalRuntimeError,
  validLlamaCppFile, validLlamaCppRepository,
  type LocalRuntimeState,
  type ModelPullProgress,
  type PullPhase,
  type RuntimeInstallProgress,
  type RuntimePreflight,
  type RuntimePublicErrorCode
} from "@joko/local-model-runtime";

import {
  managedModelRuntimeErrorMessage,
  type ManagedModelRuntimeSnapshot, type ManagedRuntimeTransfer
} from "./managed-model-runtime-controller.js";
import type { ManagedModelRuntimePort, ManagedRepositoryModel, ManagedRuntimeModelContext, ManagedRuntimeModelTarget } from "./managed-model-runtime-port.js";
import type { ManagedModelRuntimeRegistry } from "./managed-model-runtime-registry.js";

export function createManagedModelRuntimeConnectService(
  registry: ManagedModelRuntimeRegistry | undefined,
  authenticate: (context: HandlerContext) => unknown
): ServiceImpl<typeof contract.ManagedModelRuntimeService> {
  const requireController = (runtimeId: string): ManagedModelRuntimePort => {
    if (registry === undefined) throw new ConnectError("Managed local model runtimes are unavailable.", Code.Unimplemented);
    const controller = registry.get(runtimeId);
    if (controller === undefined) {
      throw new ConnectError("Managed local model runtime not found.", Code.NotFound);
    }
    return controller;
  };
  const check = (context: HandlerContext): void => {
    if (context.signal?.aborted) throw new ConnectError("The managed runtime request was cancelled.", Code.Canceled);
    authenticate(context);
  };
  const invoke = async <T>(context: HandlerContext, effect: () => Promise<T>): Promise<T> => {
    try {
      check(context); const result = await effect(); check(context); return result;
    } catch (error) {
      if (context.signal?.aborted) throw new ConnectError("The managed runtime request was cancelled.", Code.Canceled);
      throw managedRuntimeConnectError(error);
    }
  };
  return {
    ensureManagedModelRuntimeProvider: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "supportsRepositoryModels", context, check);
      if (!active.ensureProvider) throw unsupported();
      return { runtime: mapManagedModelRuntime(await active.ensureProvider(context.signal)) };
    }),
    stopManagedModelRuntime: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "canStop", context, check);
      if (!active.stop) throw unsupported();
      return { runtime: mapManagedModelRuntime(await active.stop(context.signal)) };
    }),
    restartManagedModelRuntime: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "canRestart", context, check);
      if (!active.restart) throw unsupported();
      return { runtime: mapManagedModelRuntime(await active.restart(context.signal)) };
    }),
    listManagedModelRepositoryFiles: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "supportsRepositoryModels", context, check);
      if (!active.listRepositoryFiles) throw unsupported();
      const value = await active.listRepositoryFiles(request.repository, context.signal); check(context);
      if (value.repository !== request.repository) throw new ConnectError("The repository source changed.", Code.FailedPrecondition);
      return { repository: value.repository, sourceRevision: value.sourceRevision,
        files: value.files.map(file => ({ file: file.file, sizeBytes: BigInt(file.sizeBytes) })) };
    }),
    downloadManagedRepositoryModel: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "supportsRepositoryModels", context, check);
      await requireCapability(active, "canPullModels", context, check);
      if (!active.downloadRepositoryModel) throw unsupported();
      return { runtime: mapManagedModelRuntime(await active.downloadRepositoryModel(repositoryModel(request.repositoryModel))) };
    }),
    controlManagedRepositoryDownload: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      const action = request.action === contract.ManagedRepositoryDownloadAction.PAUSE ? "pause"
        : request.action === contract.ManagedRepositoryDownloadAction.RESUME ? "resume"
          : request.action === contract.ManagedRepositoryDownloadAction.CANCEL ? "cancel" : undefined;
      if (!action || !request.transferId || request.transferId.length > 160) throw invalid();
      await requireCapability(active, action === "pause" ? "canPausePulls" : action === "resume" ? "canResumePulls" : "canCancelPulls", context, check);
      if (!active.controlRepositoryDownload) throw unsupported();
      return { runtime: mapManagedModelRuntime(await active.controlRepositoryDownload({ transferId: request.transferId,
        repositoryModel: repositoryModel(request.repositoryModel) }, action)) };
    }),
    getManagedModelContext: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "supportsRepositoryModels", context, check);
      if (!active.getModelContext) throw unsupported();
      const targets = contextTargets(request.target, request.relatedTargets);
      return { context: mapModelContext(await active.getModelContext(targets, context.signal)) };
    }),
    setManagedModelContext: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "canConfigure", context, check);
      if (!active.setModelContext || request.contextWindowTokens < 1000n || request.contextWindowTokens > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
      return { context: mapModelContext(await active.setModelContext(contextTargets(request.target, request.relatedTargets),
        Number(request.contextWindowTokens), context.signal)) };
    }),
    resetManagedModelContext: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "canConfigure", context, check);
      if (!active.setModelContext) throw unsupported();
      return { context: mapModelContext(await active.setModelContext(contextTargets(request.target, request.relatedTargets), undefined, context.signal)) };
    }),
    listManagedModelRuntimes: async (_request, context) => {
      return invoke(context, async () => ({ runtimes: registry === undefined ? []
        : await Promise.all(registry.list().map(async controller => mapManagedModelRuntime(await controller.snapshot()))) }));
    },
    getManagedModelRuntime: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await active.snapshot()) };
    }),
    startManagedModelRuntime: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await active.beginStart()) };
    }),
    installManagedModelRuntime: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await active.beginInstall()) };
    }),
    cancelManagedModelRuntimeInstall: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await active.cancelInstall()) };
    }),
    pullManagedModel: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "supportsCustomModels", context, check);
      return { runtime: mapManagedModelRuntime(await active.beginPull(request.modelName)) };
    }),
    pauseManagedModelPull: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await active.pausePull(request.modelName)) };
    }),
    resumeManagedModelPull: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await active.resumePull(request.modelName)) };
    }),
    cancelManagedModelPull: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await active.cancelPull(request.modelName)) };
    }),
    deleteManagedModel: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "canDeleteModels", context, check);
      return { runtime: mapManagedModelRuntime(await active.deleteModel(request.modelName)) };
    }),
    getManagedModelPreflight: async (request, context) => invoke(context, async () => {
      const active = requireController(request.runtimeId);
      await requireCapability(active, "supportsModelPreflight", context, check);
      return { preflight: mapPreflight(await active.preflight(request.catalogId)) };
    })
  };
}

export function mapManagedModelRuntime(snapshot: ManagedModelRuntimeSnapshot): contract.ManagedModelRuntime {
  const publicErrorCode = snapshot.publicErrorCode;
  return create(contract.ManagedModelRuntimeSchema, {
    runtimeId: snapshot.runtimeId,
    displayName: snapshot.displayName,
    state: mapRuntimeState(snapshot.state),
    source: mapRuntimeSource(snapshot.source),
    version: snapshot.version ?? "",
    capabilities: create(contract.ManagedModelRuntimeCapabilitiesSchema, {
      canInstall: snapshot.capabilities.canInstall,
      canCancelInstall: snapshot.capabilities.canCancelInstall,
      canStart: snapshot.capabilities.canStart,
      canListModels: snapshot.capabilities.canListModels,
      canPullModels: snapshot.capabilities.canPullModels,
      canDeleteModels: snapshot.capabilities.canDeleteModels,
      canPausePulls: snapshot.capabilities.canPausePulls,
      canResumePulls: snapshot.capabilities.canResumePulls,
      canCancelPulls: snapshot.capabilities.canCancelPulls,
      supportsCustomModels: snapshot.capabilities.supportsCustomModels,
      supportsCuratedCatalog: snapshot.capabilities.supportsCuratedCatalog,
      supportsModelPreflight: snapshot.capabilities.supportsModelPreflight,
      canConfigure: snapshot.capabilities.canConfigure === true,
      canStop: snapshot.capabilities.canStop === true, canRestart: snapshot.capabilities.canRestart === true,
      supportsRepositoryModels: snapshot.capabilities.supportsRepositoryModels === true,
      startupPolicy: snapshot.capabilities.startupPolicy === "on_use" ? contract.ManagedModelRuntimeStartupPolicy.ON_USE
        : snapshot.capabilities.startupPolicy === "explicit" ? contract.ManagedModelRuntimeStartupPolicy.EXPLICIT : contract.ManagedModelRuntimeStartupPolicy.UNSPECIFIED
    }),
    installPreflight: mapPreflight(snapshot.installPreflight),
    installedModels: snapshot.installedModels.map((model) => create(contract.ManagedModelRuntimeModelSchema, {
      modelName: model.name,
      displayName: model.displayName ?? model.name,
      ...(model.repositoryModel ? { repositoryModel: model.repositoryModel } : {}),
      ...(model.sizeBytes === undefined ? {} : { sizeBytes: BigInt(model.sizeBytes) }),
      ...(model.contextLength === undefined ? {} : { contextWindowTokens: BigInt(model.contextLength) }),
      supportsTools: model.capabilities.some((value) => value.toLowerCase() === "tools"),
      supportsImages: model.capabilities.some((value) => ["vision", "images", "image"].includes(value.toLowerCase())),
      requiredRuntimeVersion: model.requiredRuntimeVersion ?? ""
    })),
    catalog: snapshot.catalog.map((model) => create(contract.ManagedModelRuntimeCatalogModelSchema, {
      catalogId: model.id,
      modelName: model.libraryName,
      displayName: model.displayName,
      sizeBytes: BigInt(model.sizeBytes),
      minimumMemoryGb: model.minimumMemoryGb,
      platformLimited: model.preflight.publicErrorCode === "UNSUPPORTED_PLATFORM",
      recommended: model.recommended,
      preflight: mapPreflight(model.preflight),
      aliases: [...model.aliases], descriptions: { ...model.descriptions },
      variants: (model.variants ?? []).map(variant => ({ ...variant, sizeBytes: BigInt(variant.sizeBytes) }))
    })),
    transfers: snapshot.transfers.map(mapTransfer),
    providerRoutes: (snapshot.providerRoutes ?? []).map(route => ({ ...route })),
    ...(snapshot.hostProfile ? { hostProfile: { ...snapshot.hostProfile, totalMemoryBytes: BigInt(snapshot.hostProfile.totalMemoryBytes) } } : {}),
    configureBlockedReason: snapshot.configureBlockedReason === undefined ? contract.ManagedModelRuntimeConfigureBlockedReason.UNSPECIFIED
      : { owned_elsewhere: contract.ManagedModelRuntimeConfigureBlockedReason.OWNED_ELSEWHERE,
        ownership_unknown: contract.ManagedModelRuntimeConfigureBlockedReason.OWNERSHIP_UNKNOWN,
        operation_busy: contract.ManagedModelRuntimeConfigureBlockedReason.OPERATION_BUSY,
        stop_unconfirmed: contract.ManagedModelRuntimeConfigureBlockedReason.STOP_UNCONFIRMED }[snapshot.configureBlockedReason],
    errorCode: mapRuntimeErrorCode(publicErrorCode),
    errorMessage: publicErrorCode === undefined ? "" : managedModelRuntimeErrorMessage(publicErrorCode),
    entityVersion: create(contract.EntityVersionSchema, {
      revision: create(contract.RevisionSchema, {
        value: snapshot.revision,
        etag: `managed-model-runtime-${snapshot.revision.toString(10)}`
      }),
      generation: snapshot.revision
    })
  });
}

function mapTransfer(progress: ManagedRuntimeTransfer): contract.ManagedModelRuntimeTransfer {
  const modelPull = "name" in progress;
  return create(contract.ManagedModelRuntimeTransferSchema, {
    kind: modelPull
      ? contract.ManagedModelRuntimeTransferKind.MODEL_PULL
      : contract.ManagedModelRuntimeTransferKind.RUNTIME_INSTALL,
    modelName: modelPull ? progress.name : "",
    ...(progress.repositoryModel ? { repositoryModel: progress.repositoryModel } : {}), transferId: progress.transferId ?? "",
    phase: mapTransferPhase(progress.phase),
    ...(progress.completedBytes === undefined ? {} : { completedBytes: BigInt(Math.round(progress.completedBytes)) }),
    ...(progress.totalBytes === undefined ? {} : { totalBytes: BigInt(Math.round(progress.totalBytes)) }),
    ...(progress.percent === undefined ? {} : { percent: Math.max(0, Math.min(100, Math.round(progress.percent))) }),
    ...(progress.bytesPerSecond === undefined ? {} : { bytesPerSecond: BigInt(Math.max(0, Math.round(progress.bytesPerSecond))) }),
    done: progress.done,
    errorCode: mapRuntimeErrorCode(progress.publicErrorCode)
  });
}

function mapPreflight(value: RuntimePreflight): contract.ManagedModelRuntimePreflight {
  return create(contract.ManagedModelRuntimePreflightSchema, {
    allowed: value.allowed,
    memory: value.memory === "sufficient"
      ? contract.ManagedModelRuntimeResourceState.SUFFICIENT
      : value.memory === "constrained"
        ? contract.ManagedModelRuntimeResourceState.CONSTRAINED
        : contract.ManagedModelRuntimeResourceState.UNKNOWN,
    disk: value.disk === "sufficient"
      ? contract.ManagedModelRuntimeResourceState.SUFFICIENT
      : value.disk === "insufficient"
        ? contract.ManagedModelRuntimeResourceState.INSUFFICIENT
        : contract.ManagedModelRuntimeResourceState.UNKNOWN,
    requiredDiskBytes: BigInt(value.requiredDiskBytes),
    errorCode: mapRuntimeErrorCode(value.publicErrorCode)
  });
}

function mapRuntimeState(state: LocalRuntimeState): contract.ManagedModelRuntimeState {
  switch (state) {
    case "absent": return contract.ManagedModelRuntimeState.ABSENT;
    case "stopped": return contract.ManagedModelRuntimeState.STOPPED;
    case "starting": return contract.ManagedModelRuntimeState.STARTING;
    case "ready": return contract.ManagedModelRuntimeState.READY;
    case "port_conflict": return contract.ManagedModelRuntimeState.PORT_CONFLICT;
    case "installing": return contract.ManagedModelRuntimeState.INSTALLING;
    case "error": return contract.ManagedModelRuntimeState.ERROR;
  }
}

function mapRuntimeSource(source: ManagedModelRuntimeSnapshot["source"]): contract.ManagedModelRuntimeSource {
  switch (source) {
    case "running": return contract.ManagedModelRuntimeSource.RUNNING;
    case "application": return contract.ManagedModelRuntimeSource.APPLICATION;
    case "cli": return contract.ManagedModelRuntimeSource.CLI;
    case "managed_sidecar": return contract.ManagedModelRuntimeSource.MANAGED_SIDECAR;
    case "none": return contract.ManagedModelRuntimeSource.NONE;
  }
}

function mapTransferPhase(phase: PullPhase | RuntimeInstallProgress["phase"]): contract.ManagedModelRuntimeTransferPhase {
  switch (phase) {
    case "starting": return contract.ManagedModelRuntimeTransferPhase.STARTING;
    case "resolving": return contract.ManagedModelRuntimeTransferPhase.RESOLVING;
    case "manifest": return contract.ManagedModelRuntimeTransferPhase.MANIFEST;
    case "downloading": return contract.ManagedModelRuntimeTransferPhase.DOWNLOADING;
    case "verifying": return contract.ManagedModelRuntimeTransferPhase.VERIFYING;
    case "extracting": return contract.ManagedModelRuntimeTransferPhase.EXTRACTING;
    case "writing": return contract.ManagedModelRuntimeTransferPhase.WRITING;
    case "promoting": return contract.ManagedModelRuntimeTransferPhase.PROMOTING;
    case "success": return contract.ManagedModelRuntimeTransferPhase.SUCCESS;
    case "paused": return contract.ManagedModelRuntimeTransferPhase.PAUSED;
    case "cancelled": return contract.ManagedModelRuntimeTransferPhase.CANCELLED;
    case "error": return contract.ManagedModelRuntimeTransferPhase.ERROR;
  }
}

function mapRuntimeErrorCode(code: RuntimePublicErrorCode | undefined): contract.ManagedModelRuntimeErrorCode {
  if (code === undefined) return contract.ManagedModelRuntimeErrorCode.UNSPECIFIED;
  const values: Record<RuntimePublicErrorCode, contract.ManagedModelRuntimeErrorCode> = {
    OWNER_CHANGED: contract.ManagedModelRuntimeErrorCode.OWNER_CHANGED,
    RUNTIME_UNREACHABLE: contract.ManagedModelRuntimeErrorCode.RUNTIME_UNREACHABLE,
    PORT_CONFLICT: contract.ManagedModelRuntimeErrorCode.PORT_CONFLICT,
    UNSUPPORTED_PLATFORM: contract.ManagedModelRuntimeErrorCode.UNSUPPORTED_PLATFORM,
    INSTALL_BUSY: contract.ManagedModelRuntimeErrorCode.INSTALL_BUSY,
    PULL_BUSY: contract.ManagedModelRuntimeErrorCode.PULL_BUSY,
    MODEL_INVALID: contract.ManagedModelRuntimeErrorCode.MODEL_INVALID,
    MODEL_NOT_FOUND: contract.ManagedModelRuntimeErrorCode.MODEL_NOT_FOUND,
    MODEL_UNAUTHORIZED: contract.ManagedModelRuntimeErrorCode.MODEL_UNAUTHORIZED,
    MODEL_INCOMPATIBLE: contract.ManagedModelRuntimeErrorCode.MODEL_INCOMPATIBLE,
    DISK_SPACE_LOW: contract.ManagedModelRuntimeErrorCode.DISK_SPACE_LOW,
    DOWNLOAD_REJECTED: contract.ManagedModelRuntimeErrorCode.DOWNLOAD_REJECTED,
    DOWNLOAD_TOO_LARGE: contract.ManagedModelRuntimeErrorCode.DOWNLOAD_TOO_LARGE,
    DOWNLOAD_TIMEOUT: contract.ManagedModelRuntimeErrorCode.DOWNLOAD_TIMEOUT,
    CHECKSUM_MISMATCH: contract.ManagedModelRuntimeErrorCode.CHECKSUM_MISMATCH,
    ARCHIVE_REJECTED: contract.ManagedModelRuntimeErrorCode.ARCHIVE_REJECTED,
    START_FAILED: contract.ManagedModelRuntimeErrorCode.START_FAILED,
    OPERATION_CANCELLED: contract.ManagedModelRuntimeErrorCode.OPERATION_CANCELLED,
    RUNTIME_ERROR: contract.ManagedModelRuntimeErrorCode.RUNTIME_ERROR
  };
  return values[code];
}

function managedRuntimeConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (!(error instanceof LocalRuntimeError)) {
    return new ConnectError("The local model operation failed.", Code.Internal);
  }
  const code = error.code === "MODEL_INVALID" ? Code.InvalidArgument
    : error.code === "MODEL_NOT_FOUND" ? Code.NotFound
      : error.code === "OWNER_CHANGED" || error.code === "INSTALL_BUSY" || error.code === "PULL_BUSY" ? Code.Aborted
        : error.code === "RUNTIME_UNREACHABLE" ? Code.Unavailable
          : error.code === "OPERATION_CANCELLED" ? Code.Canceled
            : Code.FailedPrecondition;
  return new ConnectError(managedModelRuntimeErrorMessage(error.code), code);
}

async function requireCapability(active: ManagedModelRuntimePort, capability: keyof ManagedModelRuntimeSnapshot["capabilities"],
  context: HandlerContext, check: (context: HandlerContext) => void): Promise<void> {
  const state = await active.snapshot(); check(context);
  if (state.runtimeId !== active.runtimeId || state.capabilities[capability] !== true) throw unsupported();
}
function repositoryModel(value: contract.ManagedRepositoryModel | undefined): ManagedRepositoryModel {
  if (!value || !validLlamaCppRepository(value.repository) || !validLlamaCppFile(value.file)) throw invalid();
  return { repository: value.repository, file: value.file };
}
function contextTargets(primary: contract.ManagedModelRuntimeModelTarget | undefined,
  related: readonly contract.ManagedModelRuntimeModelTarget[]): readonly ManagedRuntimeModelTarget[] {
  if (!primary || related.length > 2) throw invalid();
  const ids = new Set<string>();
  return [primary, ...related].map(value => {
    if ([value.backendId, value.providerId, value.modelId].some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id))
      || value.providerId !== primary.providerId || value.modelId !== primary.modelId || ids.has(value.backendId)) throw invalid();
    ids.add(value.backendId);
    const source = repositoryModel(value.repositoryModel);
    if (source.repository !== primary.repositoryModel?.repository || source.file !== primary.repositoryModel.file) throw invalid();
    return { backendId: value.backendId, providerId: value.providerId, modelId: value.modelId, repositoryModel: source };
  });
}
function mapModelContext(value: ManagedRuntimeModelContext): contract.ManagedModelContext {
  return create(contract.ManagedModelContextSchema, { target: value.target,
    defaultContextWindowTokens: BigInt(value.defaultContextWindowTokens), effectiveContextWindowTokens: BigInt(value.effectiveContextWindowTokens),
    maximumContextWindowTokens: BigInt(value.maximumContextWindowTokens), presets: value.presets.map(limit => BigInt(limit)),
    customized: value.customized, canConfigure: value.canConfigure, pendingApply: value.pendingApply, mixed: value.mixed });
}
function invalid(): ConnectError { return new ConnectError("The managed model selection is invalid.", Code.InvalidArgument); }
function unsupported(): ConnectError { return new ConnectError("The requested managed runtime capability is unavailable.", Code.FailedPrecondition); }
