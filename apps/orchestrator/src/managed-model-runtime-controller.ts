import {
  LocalRuntimeError,
  canonicalModelName,
  type CuratedLocalModel,
  type InstalledLocalModel,
  type LocalModelRuntimeManager,
  type LocalRuntimeCapabilities,
  type LocalRuntimeState,
  type LocalRuntimeStatus,
  type ModelPullProgress,
  type RuntimeInstallProgress,
  type RuntimeOwnerGeneration,
  type RuntimePreflight,
  type RuntimePublicErrorCode
} from "@joko/local-model-runtime";

export interface ManagedModelRuntimeCatalogEntry extends CuratedLocalModel {
  readonly recommended: boolean;
  readonly preflight: RuntimePreflight;
}

export interface ManagedModelRuntimeCapabilityProfile extends LocalRuntimeCapabilities {
  readonly canCancelInstall: boolean;
  readonly canResumePulls: boolean;
  readonly canCancelPulls: boolean;
  readonly supportsCustomModels: boolean;
  readonly supportsCuratedCatalog: boolean;
  readonly supportsModelPreflight: boolean;
}

export interface ManagedModelRuntimeSnapshot {
  readonly runtimeId: string;
  readonly displayName: string;
  readonly state: LocalRuntimeState;
  readonly source: LocalRuntimeStatus["source"];
  readonly version?: string;
  readonly capabilities: ManagedModelRuntimeCapabilityProfile;
  readonly installPreflight: RuntimePreflight;
  readonly installedModels: readonly InstalledLocalModel[];
  readonly catalog: readonly ManagedModelRuntimeCatalogEntry[];
  readonly transfers: readonly (ModelPullProgress | RuntimeInstallProgress)[];
  readonly publicErrorCode?: RuntimePublicErrorCode;
  readonly revision: bigint;
  readonly updatedAt: number;
}

export interface ManagedModelRuntimeManagerPort {
  status(owner: RuntimeOwnerGeneration): Promise<LocalRuntimeStatus>;
  curated(owner: RuntimeOwnerGeneration): {
    readonly catalog: readonly CuratedLocalModel[];
    readonly recommended: readonly CuratedLocalModel[];
  };
  runtimePreflight(owner: RuntimeOwnerGeneration, freeDiskBytes?: number): RuntimePreflight;
  modelPreflight(owner: RuntimeOwnerGeneration, catalogId: string, freeDiskBytes?: number): RuntimePreflight;
  installProgress(owner: RuntimeOwnerGeneration): RuntimeInstallProgress | undefined;
  list(owner: RuntimeOwnerGeneration, signal?: AbortSignal): Promise<readonly InstalledLocalModel[]>;
  paused(owner: RuntimeOwnerGeneration): Promise<readonly ModelPullProgress[]>;
  activePulls(owner: RuntimeOwnerGeneration): readonly ModelPullProgress[];
  start(owner: RuntimeOwnerGeneration, signal?: AbortSignal): Promise<LocalRuntimeStatus>;
  install(owner: RuntimeOwnerGeneration): Promise<LocalRuntimeStatus>;
  abortInstall(owner: RuntimeOwnerGeneration): void;
  pull(owner: RuntimeOwnerGeneration, modelName: string): Promise<void>;
  pause(owner: RuntimeOwnerGeneration, modelName: string): Promise<void>;
  resume(owner: RuntimeOwnerGeneration, modelName: string): Promise<void>;
  cancel(owner: RuntimeOwnerGeneration, modelName: string): Promise<void>;
  delete(owner: RuntimeOwnerGeneration, modelName: string): Promise<void>;
  shutdown(owner: RuntimeOwnerGeneration): Promise<void>;
}

export interface ManagedModelRuntimeControllerOptions {
  readonly manager: ManagedModelRuntimeManagerPort;
  readonly owner: RuntimeOwnerGeneration;
  readonly runtimeId?: string;
  readonly displayName?: string;
  readonly freeDiskBytes?: () => Promise<number | undefined>;
  readonly now?: () => number;
}

/**
 * Orchestrator-owned façade around a local inference runtime. It intentionally owns
 * operation lifetimes so an HTTP client disconnect never transfers process or
 * download ownership to a renderer.
 */
export class ManagedModelRuntimeController {
  readonly runtimeId: string;
  readonly displayName: string;
  private readonly manager: ManagedModelRuntimeManagerPort;
  private readonly owner: RuntimeOwnerGeneration;
  private readonly now: () => number;
  private startAbort: AbortController | undefined;
  private startTask: Promise<void> | undefined;
  private installTask: Promise<void> | undefined;
  private readonly pullTasks = new Map<string, Promise<void>>();
  private lastError: RuntimePublicErrorCode | undefined;
  private revision = 0n;
  private lastProjection = "";
  private closed = false;

  constructor(private readonly options: ManagedModelRuntimeControllerOptions) {
    this.manager = options.manager;
    this.owner = options.owner;
    this.runtimeId = options.runtimeId ?? "ollama";
    this.displayName = options.displayName ?? "Ollama";
    this.now = options.now ?? Date.now;
  }

  async snapshot(): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    const freeDiskBytes = await this.readFreeDiskBytes();
    let status = await this.manager.status(this.owner);
    const [installedModels, paused] = await Promise.all([
      status.state === "ready" ? this.manager.list(this.owner) : Promise.resolve([]),
      this.manager.paused(this.owner)
    ]).catch((error: unknown) => {
      this.captureError(error);
      return [[], []] as const;
    });
    const curated = this.manager.curated(this.owner);
    const recommended = new Set(curated.recommended.map((model) => model.id));
    const catalog = curated.catalog.map((model): ManagedModelRuntimeCatalogEntry => ({
      ...model,
      recommended: recommended.has(model.id),
      preflight: this.manager.modelPreflight(this.owner, model.id, freeDiskBytes)
    }));
    const installProgress = this.manager.installProgress(this.owner);
    const activePulls = this.manager.activePulls(this.owner);
    const pulls = mergePullProgress(activePulls, paused);
    if (this.installTask !== undefined) {
      status = { ...status, state: "installing" };
    } else if (this.startTask !== undefined && status.state !== "ready" && status.state !== "port_conflict") {
      status = { ...status, state: "starting" };
    }
    const capabilities: ManagedModelRuntimeCapabilityProfile = {
      ...status.capabilities,
      canCancelInstall: this.installTask !== undefined,
      canResumePulls: paused.length > 0 && status.capabilities.canPullModels,
      canCancelPulls: pulls.length > 0,
      supportsCustomModels: status.capabilities.canPullModels,
      supportsCuratedCatalog: true,
      supportsModelPreflight: true
    };
    const projection = JSON.stringify({
      status,
      capabilities,
      installPreflight: this.manager.runtimePreflight(this.owner, freeDiskBytes),
      installedModels,
      catalog,
      transfers: [...(installProgress === undefined ? [] : [installProgress]), ...pulls],
      lastError: this.lastError
    });
    if (projection !== this.lastProjection) {
      this.lastProjection = projection;
      this.revision += 1n;
    }
    return {
      runtimeId: this.runtimeId,
      displayName: this.displayName,
      state: status.state,
      source: status.source,
      ...(status.version === undefined ? {} : { version: status.version }),
      capabilities,
      installPreflight: this.manager.runtimePreflight(this.owner, freeDiskBytes),
      installedModels,
      catalog,
      transfers: [...(installProgress === undefined ? [] : [installProgress]), ...pulls],
      ...(this.lastError ?? status.publicErrorCode) === undefined
        ? {}
        : { publicErrorCode: (this.lastError ?? status.publicErrorCode)! },
      revision: this.revision,
      updatedAt: this.now()
    };
  }

  preflight(catalogId: string): Promise<RuntimePreflight> {
    this.assertOpen();
    return this.readFreeDiskBytes().then((freeDiskBytes) => this.manager.modelPreflight(this.owner, catalogId, freeDiskBytes));
  }

  async beginStart(): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    this.lastError = undefined;
    if (this.startTask === undefined) {
      const abort = new AbortController();
      this.startAbort = abort;
      const task = this.manager.start(this.owner, abort.signal)
        .then(() => { this.lastError = undefined; })
        .catch((error: unknown) => { this.captureError(error); })
        .finally(() => {
          if (this.startTask === task) this.startTask = undefined;
          if (this.startAbort === abort) this.startAbort = undefined;
        });
      this.startTask = task;
    }
    return this.snapshot();
  }

  async beginInstall(): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    const preflight = await this.preflightRuntimeInstall();
    if (!preflight.allowed) throw new LocalRuntimeError(preflight.publicErrorCode ?? "RUNTIME_ERROR", "The runtime cannot be installed on this host.");
    this.lastError = undefined;
    if (this.installTask === undefined) {
      const task = this.manager.install(this.owner)
        .then(() => { this.lastError = undefined; })
        .catch((error: unknown) => { this.captureError(error); })
        .finally(() => { if (this.installTask === task) this.installTask = undefined; });
      this.installTask = task;
    }
    return this.snapshot();
  }

  async cancelInstall(): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    this.manager.abortInstall(this.owner);
    await this.installTask;
    return this.snapshot();
  }

  async beginPull(modelName: string): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    await this.assertModelPreflight(modelName);
    this.lastError = undefined;
    const key = canonicalModelName(modelName);
    if (!this.pullTasks.has(key)) {
      const task = this.manager.pull(this.owner, modelName)
        .then(() => { this.lastError = undefined; })
        .catch((error: unknown) => {
          const code = runtimeErrorCode(error);
          if (code !== "OPERATION_CANCELLED") this.lastError = code;
        })
        .finally(() => { if (this.pullTasks.get(key) === task) this.pullTasks.delete(key); });
      this.pullTasks.set(key, task);
    }
    return this.snapshot();
  }

  async pausePull(modelName: string): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    await this.manager.pause(this.owner, modelName);
    await this.pullTasks.get(canonicalModelName(modelName));
    return this.snapshot();
  }

  async resumePull(modelName: string): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    await this.assertModelPreflight(modelName);
    this.lastError = undefined;
    const key = canonicalModelName(modelName);
    if (!this.pullTasks.has(key)) {
      const task = this.manager.resume(this.owner, modelName)
        .then(() => { this.lastError = undefined; })
        .catch((error: unknown) => {
          const code = runtimeErrorCode(error);
          if (code !== "OPERATION_CANCELLED") this.lastError = code;
        })
        .finally(() => { if (this.pullTasks.get(key) === task) this.pullTasks.delete(key); });
      this.pullTasks.set(key, task);
    }
    return this.snapshot();
  }

  async cancelPull(modelName: string): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    await this.manager.cancel(this.owner, modelName);
    await this.pullTasks.get(canonicalModelName(modelName));
    return this.snapshot();
  }

  async deleteModel(modelName: string): Promise<ManagedModelRuntimeSnapshot> {
    this.assertOpen();
    this.lastError = undefined;
    try {
      await this.manager.delete(this.owner, modelName);
    } catch (error) {
      this.captureError(error);
      throw error;
    }
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.startAbort?.abort();
    await this.manager.shutdown(this.owner);
    await Promise.allSettled([
      ...(this.startTask === undefined ? [] : [this.startTask]),
      ...(this.installTask === undefined ? [] : [this.installTask]),
      ...this.pullTasks.values()
    ]);
    this.closed = true;
  }

  private async preflightRuntimeInstall(): Promise<RuntimePreflight> {
    return this.manager.runtimePreflight(this.owner, await this.readFreeDiskBytes());
  }

  private async assertModelPreflight(modelName: string): Promise<void> {
    const item = this.manager.curated(this.owner).catalog.find((model) => canonicalModelName(model.libraryName) === canonicalModelName(modelName));
    if (item === undefined) return;
    const preflight = this.manager.modelPreflight(this.owner, item.id, await this.readFreeDiskBytes());
    if (!preflight.allowed) throw new LocalRuntimeError(preflight.publicErrorCode ?? "RUNTIME_ERROR", "The model cannot be pulled on this host.");
  }

  private async readFreeDiskBytes(): Promise<number | undefined> {
    try {
      const value = await this.options.freeDiskBytes?.();
      return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private captureError(error: unknown): void {
    this.lastError = runtimeErrorCode(error);
  }

  private assertOpen(): void {
    if (this.closed) throw new LocalRuntimeError("OWNER_CHANGED", "The runtime owner is no longer active.");
  }
}

export type ConcreteManagedModelRuntimeManager = LocalModelRuntimeManager;

export function managedModelRuntimeErrorMessage(code: RuntimePublicErrorCode): string {
  switch (code) {
    case "OWNER_CHANGED": return "The service owner changed. Refresh and try again.";
    case "RUNTIME_UNREACHABLE": return "The local model runtime is not reachable.";
    case "PORT_CONFLICT": return "Another service is using the local model runtime port.";
    case "UNSUPPORTED_PLATFORM": return "Managed installation is unavailable on this platform.";
    case "INSTALL_BUSY": return "A runtime installation is already in progress.";
    case "PULL_BUSY": return "This model already has an active transfer.";
    case "MODEL_INVALID": return "Enter a valid model name.";
    case "MODEL_NOT_FOUND": return "The selected model could not be found.";
    case "MODEL_UNAUTHORIZED": return "The selected model requires additional access.";
    case "MODEL_INCOMPATIBLE": return "The selected model is incompatible with this runtime.";
    case "DISK_SPACE_LOW": return "There is not enough free disk space for this operation.";
    case "DOWNLOAD_REJECTED": return "The runtime download was rejected by the host policy.";
    case "DOWNLOAD_TOO_LARGE": return "The runtime download exceeds the managed size limit.";
    case "DOWNLOAD_TIMEOUT": return "The runtime download timed out.";
    case "CHECKSUM_MISMATCH": return "The runtime download failed its integrity check.";
    case "ARCHIVE_REJECTED": return "The runtime archive failed the safety check.";
    case "START_FAILED": return "The local model runtime could not be started.";
    case "OPERATION_CANCELLED": return "The operation was cancelled.";
    case "RUNTIME_ERROR": return "The local model operation failed.";
  }
}

function runtimeErrorCode(error: unknown): RuntimePublicErrorCode {
  return error instanceof LocalRuntimeError ? error.code : "RUNTIME_ERROR";
}

function mergePullProgress(
  active: readonly ModelPullProgress[],
  paused: readonly ModelPullProgress[]
): readonly ModelPullProgress[] {
  const values = new Map<string, ModelPullProgress>();
  for (const progress of paused) values.set(canonicalModelName(progress.name), progress);
  for (const progress of active) values.set(canonicalModelName(progress.name), progress);
  return [...values.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
}
