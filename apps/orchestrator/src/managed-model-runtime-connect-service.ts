import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  LocalRuntimeError,
  type LocalRuntimeState,
  type ModelPullProgress,
  type PullPhase,
  type RuntimeInstallProgress,
  type RuntimePreflight,
  type RuntimePublicErrorCode
} from "@joko/local-model-runtime";

import {
  ManagedModelRuntimeController,
  managedModelRuntimeErrorMessage,
  type ManagedModelRuntimeSnapshot
} from "./managed-model-runtime-controller.js";

export function createManagedModelRuntimeConnectService(
  controller: ManagedModelRuntimeController | undefined,
  authenticate: (context: HandlerContext) => unknown
): ServiceImpl<typeof contract.ManagedModelRuntimeService> {
  const requireController = (runtimeId?: string): ManagedModelRuntimeController => {
    if (controller === undefined) throw new ConnectError("Managed local model runtimes are unavailable.", Code.Unimplemented);
    if (runtimeId !== undefined && runtimeId !== controller.runtimeId) {
      throw new ConnectError("Managed local model runtime not found.", Code.NotFound);
    }
    return controller;
  };
  const invoke = async <T>(effect: () => Promise<T>): Promise<T> => {
    try {
      return await effect();
    } catch (error) {
      throw managedRuntimeConnectError(error);
    }
  };
  return {
    listManagedModelRuntimes: async (_request, context) => {
      authenticate(context);
      if (controller === undefined) return { runtimes: [] };
      return { runtimes: [mapManagedModelRuntime(await invoke(() => controller.snapshot()))] };
    },
    getManagedModelRuntime: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.snapshot())) };
    },
    startManagedModelRuntime: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.beginStart())) };
    },
    installManagedModelRuntime: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.beginInstall())) };
    },
    cancelManagedModelRuntimeInstall: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.cancelInstall())) };
    },
    pullManagedModel: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.beginPull(request.modelName))) };
    },
    pauseManagedModelPull: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.pausePull(request.modelName))) };
    },
    resumeManagedModelPull: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.resumePull(request.modelName))) };
    },
    cancelManagedModelPull: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.cancelPull(request.modelName))) };
    },
    deleteManagedModel: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { runtime: mapManagedModelRuntime(await invoke(() => active.deleteModel(request.modelName))) };
    },
    getManagedModelPreflight: async (request, context) => {
      authenticate(context);
      const active = requireController(request.runtimeId);
      return { preflight: mapPreflight(await invoke(() => active.preflight(request.catalogId))) };
    }
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
      supportsModelPreflight: snapshot.capabilities.supportsModelPreflight
    }),
    installPreflight: mapPreflight(snapshot.installPreflight),
    installedModels: snapshot.installedModels.map((model) => create(contract.ManagedModelRuntimeModelSchema, {
      modelName: model.name,
      displayName: model.name,
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
      preflight: mapPreflight(model.preflight)
    })),
    transfers: snapshot.transfers.map(mapTransfer),
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

function mapTransfer(progress: ModelPullProgress | RuntimeInstallProgress): contract.ManagedModelRuntimeTransfer {
  const modelPull = "name" in progress;
  return create(contract.ManagedModelRuntimeTransferSchema, {
    kind: modelPull
      ? contract.ManagedModelRuntimeTransferKind.MODEL_PULL
      : contract.ManagedModelRuntimeTransferKind.RUNTIME_INSTALL,
    modelName: modelPull ? progress.name : "",
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
