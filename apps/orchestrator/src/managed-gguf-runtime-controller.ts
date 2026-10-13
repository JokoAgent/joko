import { arch, platform, totalmem } from "node:os";
import { LocalRuntimeError, assertLlamaCppSelection, llamaCppContextSize, llamaCppMaximumContext,
  validLlamaCppRepository, type LlamaCppModel, type LlamaCppRepository, type LlamaCppSelection,
  selectGgufShards,
  type LlamaCppSnapshot, type LlamaCppTransferTarget, type RuntimeOwnerGeneration, type RuntimePublicErrorCode,
  type RuntimePreflight } from "@joko/local-model-runtime";
import type { ManagedModelRuntimeSnapshot, ManagedRuntimeTransfer } from "./managed-model-runtime-controller.js";
import type { ManagedModelRuntimePort, ManagedRepositoryModel, ManagedRuntimeModelContext, ManagedRuntimeModelTarget,
  ManagedRuntimeProviderRoute, ManagedRuntimeRepositoryDownloadAction, ManagedRuntimeRepositoryFiles,
  ManagedRuntimeTransferTarget } from "./managed-model-runtime-port.js";

export interface ManagedGgufEnginePort {
  snapshot(owner: RuntimeOwnerGeneration): Promise<LlamaCppSnapshot>;
  listRepositoryFiles(owner: RuntimeOwnerGeneration, repository: string, signal?: AbortSignal): Promise<LlamaCppRepository>;
  install(owner: RuntimeOwnerGeneration): Promise<void>;
  download(owner: RuntimeOwnerGeneration, selection: LlamaCppSelection): Promise<void>;
  pause(owner: RuntimeOwnerGeneration, target: LlamaCppTransferTarget): Promise<void>;
  resume(owner: RuntimeOwnerGeneration, target: LlamaCppTransferTarget): Promise<void>;
  cancel(owner: RuntimeOwnerGeneration, target: LlamaCppTransferTarget): Promise<void>;
  start(owner: RuntimeOwnerGeneration, options?: { readonly restart?: boolean; readonly signal?: AbortSignal }): Promise<void>;
  stop(owner: RuntimeOwnerGeneration): Promise<void>;
  dispose(owner: RuntimeOwnerGeneration): Promise<void>;
}
export interface ManagedGgufRuntimeControllerOptions {
  readonly manager: ManagedGgufEnginePort;
  readonly owner: RuntimeOwnerGeneration;
  readonly currentOwner: () => RuntimeOwnerGeneration | undefined;
  readonly providerRoutes: () => readonly ManagedRuntimeProviderRoute[];
  readonly ensureProvider: (signal?: AbortSignal) => Promise<void>;
  readonly getModelContext: (targets: readonly ManagedRuntimeModelTarget[], signal?: AbortSignal) => Promise<ManagedRuntimeModelContext>;
  /** The context Owner performs one configuration transaction for precisely these existing routes. */
  readonly setModelContext: (targets: readonly ManagedRuntimeModelTarget[], limit: number | undefined, signal?: AbortSignal) => Promise<ManagedRuntimeModelContext>;
  readonly runtimeId?: string;
  readonly displayName?: string;
  readonly now?: () => number;
  readonly hostPlatform?: string;
  readonly hostArch?: string;
  readonly totalMemoryBytes?: () => number;
}

export class ManagedGgufRuntimeController implements ManagedModelRuntimePort {
  readonly runtimeId: string;
  readonly #options: ManagedGgufRuntimeControllerOptions;
  #flight?: { readonly kind: "install" | "download" | "start"; readonly token: symbol; readonly task: Promise<void> };
  #lastTransfer?: ManagedRuntimeTransfer;
  #activeTransferId?: string;
  #error?: RuntimePublicErrorCode;
  #closed = false;
  #closing = false;
  #snapshotOrdinal = 0;
  #committedOrdinal = 0;
  #projection = "";
  #revision = 0n;
  #committed?: ManagedModelRuntimeSnapshot;
  constructor(options: ManagedGgufRuntimeControllerOptions) { this.#options = options; this.runtimeId = options.runtimeId ?? "llama-cpp"; }

  async snapshot(): Promise<ManagedModelRuntimeSnapshot> {
    this.#assertOwner(); const ordinal = ++this.#snapshotOrdinal;
    const state = await this.#options.manager.snapshot(this.#options.owner); this.#assertOwner();
    const routes = this.#routes();
    const active = state.operation;
    if (active && ordinal >= this.#committedOrdinal) this.#activeTransferId = active.transferId;
    const busy = active !== undefined || this.#flight !== undefined;
    const canConfigure = state.canConfigure && !busy;
    const preflight = (requiredDiskBytes = 0): RuntimePreflight => ({ allowed: state.supported && canConfigure,
      memory: "unknown", disk: "unknown", requiredDiskBytes,
      ...(!state.supported ? { publicErrorCode: "UNSUPPORTED_PLATFORM" as const } : {}) });
    const transferProgress = active ? { transferId: active.transferId,
      completedBytes: active.completed, totalBytes: active.total,
      ...(active.bytesPerSecond === undefined ? {} : { bytesPerSecond: active.bytesPerSecond }), done: false
    } : undefined;
    const transfer: ManagedRuntimeTransfer | undefined = active
      ? active.kind === "download"
        ? { ...transferProgress!, name: active.selection!.file, status: active.paused ? "paused" : "downloading",
          repositoryModel: active.selection, phase: active.paused ? "paused"
            : active.total > 0 && active.completed >= active.total ? "verifying" : "downloading" }
        : { ...transferProgress!, phase: active.kind === "start" ? "starting"
          : active.total > 0 && active.completed >= active.total ? "verifying" : "downloading" }
      : this.#lastTransfer;
    const models = state.models.map(model => ({ name: model.id, displayName: `${model.repository.split("/")[1]} · ${model.file.split("/").at(-1)}`,
      repositoryModel: { repository: model.repository, file: model.file }, sizeBytes: model.sizeBytes,
      contextLength: llamaCppContextSize(model), capabilities: [] as readonly string[] }));
    const projected = { runtimeId: this.runtimeId, displayName: this.#options.displayName ?? "llama.cpp",
      state: active?.kind === "install" || this.#flight?.kind === "install" ? "installing" as const
        : active?.kind === "start" || this.#flight?.kind === "start" ? "starting" as const
          : state.running ? "ready" as const : !state.installed ? "absent" as const
            : this.#error === "PORT_CONFLICT" ? "port_conflict" as const : "stopped" as const,
      source: state.running ? state.canManageRuntime ? "managed_sidecar" as const : "running" as const : "none" as const,
      ...(state.version === undefined ? {} : { version: state.version }),
      capabilities: { canInstall: state.supported && !state.installed && canConfigure,
        canCancelInstall: active?.kind === "install", canStart: state.installed && !state.running && canConfigure,
        canListModels: true, canPullModels: state.installed && canConfigure, canDeleteModels: false,
        canPausePulls: state.canPauseDownload && active?.kind === "download" && !active.paused,
        canResumePulls: state.canPauseDownload && active?.kind === "download" && active.paused === true,
        canCancelPulls: active?.kind === "download", supportsCustomModels: false, supportsCuratedCatalog: true,
        supportsModelPreflight: false, canConfigure, canStop: state.canManageRuntime && !busy,
        canRestart: state.canManageRuntime && canConfigure, supportsRepositoryModels: true, startupPolicy: "on_use" as const },
      installPreflight: preflight(), installedModels: models,
      catalog: state.catalog.map(entry => ({ id: entry.id, displayName: entry.name, libraryName: entry.id,
        aliases: entry.aliases, ...(entry.descriptions ? { descriptions: entry.descriptions } : {}),
        variants: entry.variants.map(variant => ({ repositoryModel: { repository: variant.repository, file: variant.file },
          quantization: variant.quantization, sizeBytes: variant.sizeBytes })),
        sizeBytes: Math.min(...entry.variants.map(variant => variant.sizeBytes)), minimumMemoryGb: 0, appleSiliconOnly: false,
        recommended: state.recommendation.featuredIds.includes(entry.id), preflight: preflight() })),
      transfers: transfer ? [transfer] : [], providerRoutes: routes,
      hostProfile: { platform: this.#options.hostPlatform ?? platform(), arch: this.#options.hostArch ?? arch(),
        totalMemoryBytes: (this.#options.totalMemoryBytes ?? totalmem)(), memoryGb: state.recommendation.memoryGb,
        appleSilicon: state.recommendation.appleSilicon, ...(state.recommendation.chip ? { chip: state.recommendation.chip } : {}) },
      ...(state.blockedReason ? { configureBlockedReason: state.blockedReason } : busy ? { configureBlockedReason: "operation_busy" as const } : {}),
      ...(this.#error ? { publicErrorCode: this.#error } : {}) };
    if (ordinal < this.#committedOrdinal && this.#committed) return this.#committed;
    const encoded = JSON.stringify(projected);
    if (encoded !== this.#projection) { this.#projection = encoded; this.#revision++; }
    const result: ManagedModelRuntimeSnapshot = { ...projected, revision: this.#revision,
      updatedAt: (this.#options.now ?? Date.now)() };
    this.#committedOrdinal = ordinal; this.#committed = result; return result;
  }
  async ensureProvider(signal?: AbortSignal): Promise<ManagedModelRuntimeSnapshot> {
    this.#assertOwner(signal); await this.#options.ensureProvider(signal); this.#assertOwner(signal); return this.snapshot();
  }
  async beginStart(): Promise<ManagedModelRuntimeSnapshot> {
    await this.#requireCapability("canStart"); return this.#begin("start", () => this.#options.manager.start(this.#options.owner));
  }
  async restart(signal?: AbortSignal): Promise<ManagedModelRuntimeSnapshot> {
    await this.#requireCapability("canRestart", signal);
    return this.#begin("start", () => this.#options.manager.start(this.#options.owner, { restart: true }));
  }
  async stop(signal?: AbortSignal): Promise<ManagedModelRuntimeSnapshot> {
    await this.#requireCapability("canStop", signal);
    await this.#options.manager.stop(this.#options.owner); this.#assertOwner(signal); return this.snapshot();
  }
  async beginInstall(): Promise<ManagedModelRuntimeSnapshot> {
    await this.#requireCapability("canInstall"); return this.#begin("install", () => this.#options.manager.install(this.#options.owner));
  }
  async cancelInstall(): Promise<ManagedModelRuntimeSnapshot> {
    this.#assertOwner(); const state = await this.#options.manager.snapshot(this.#options.owner); this.#assertOwner();
    if (state.operation?.kind !== "install") throw unavailable();
    await this.#options.manager.cancel(this.#options.owner, { transferId: state.operation.transferId }); this.#assertOwner(); return this.snapshot();
  }
  async listRepositoryFiles(repository: string, signal?: AbortSignal): Promise<ManagedRuntimeRepositoryFiles> {
    this.#assertOwner(signal); if (!validLlamaCppRepository(repository)) throw invalid();
    const value = await this.#options.manager.listRepositoryFiles(this.#options.owner, repository, signal); this.#assertOwner(signal);
    const files = value.files.filter(file => !/-\d{5}-of-\d{5}\.gguf$/u.test(file.name) || /-00001-of-\d{5}\.gguf$/u.test(file.name))
      .flatMap(file => {
        try {
          const sizeBytes = selectGgufShards(value.files, file.name).reduce((sum, shard) => sum + shard.sizeBytes, 0);
          return Number.isSafeInteger(sizeBytes) ? [{ file: file.name, sizeBytes }] : [];
        } catch { return []; }
      });
    return { repository, sourceRevision: value.revision, files };
  }
  async downloadRepositoryModel(selection: ManagedRepositoryModel): Promise<ManagedModelRuntimeSnapshot> {
    assertLlamaCppSelection(selection); await this.#requireCapability("canPullModels");
    return this.#begin("download", () => this.#options.manager.download(this.#options.owner, selection), selection);
  }
  async controlRepositoryDownload(target: ManagedRuntimeTransferTarget, action: ManagedRuntimeRepositoryDownloadAction): Promise<ManagedModelRuntimeSnapshot> {
    this.#assertOwner(); assertLlamaCppSelection(target.repositoryModel); if (!target.transferId) throw invalid();
    const manager = this.#options.manager;
    await manager[action](this.#options.owner, { transferId: target.transferId, selection: target.repositoryModel });
    this.#assertOwner(); return this.snapshot();
  }
  async getModelContext(targets: readonly ManagedRuntimeModelTarget[], signal?: AbortSignal): Promise<ManagedRuntimeModelContext> {
    await this.#validateTargets(targets, signal);
    const value = await this.#options.getModelContext(targets, signal); this.#assertOwner(signal);
    const model = await this.#validateTargets(targets, signal);
    const state = await this.snapshot(); this.#assertOwner(signal);
    return this.#context({ ...value, canConfigure: value.canConfigure && state.capabilities.canConfigure === true }, targets, model);
  }
  async setModelContext(targets: readonly ManagedRuntimeModelTarget[], limit: number | undefined, signal?: AbortSignal): Promise<ManagedRuntimeModelContext> {
    await this.#requireCapability("canConfigure", signal); const model = await this.#validateTargets(targets, signal);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1000 || limit > llamaCppMaximumContext(model))) throw invalid();
    const value = await this.#options.setModelContext(targets, limit, signal); this.#assertOwner(signal);
    const current = await this.#validateTargets(targets, signal); return this.#context(value, targets, current);
  }
  async preflight(_catalogId: string): Promise<RuntimePreflight> { throw unavailable(); }
  async beginPull(_modelName: string): Promise<ManagedModelRuntimeSnapshot> { throw unavailable(); }
  async pausePull(_modelName: string): Promise<ManagedModelRuntimeSnapshot> { throw unavailable(); }
  async resumePull(_modelName: string): Promise<ManagedModelRuntimeSnapshot> { throw unavailable(); }
  async cancelPull(_modelName: string): Promise<ManagedModelRuntimeSnapshot> { throw unavailable(); }
  async deleteModel(_modelName: string): Promise<ManagedModelRuntimeSnapshot> { throw unavailable(); }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closing = true;
    await this.#options.manager.dispose(this.#options.owner); await this.#flight?.task; this.#closed = true;
  }
  async #begin(kind: "install" | "download" | "start", effect: () => Promise<void>, selection?: ManagedRepositoryModel): Promise<ManagedModelRuntimeSnapshot> {
    this.#assertOwner(); if (this.#flight) throw new LocalRuntimeError("INSTALL_BUSY", "A runtime operation is active.");
    this.#error = undefined; this.#lastTransfer = undefined; this.#activeTransferId = undefined;
    const token = Symbol(kind);
    const task = Promise.resolve().then(effect).then(() => {
      this.#assertOwner();
      if (selection) this.#lastTransfer = { name: selection.file, status: "success", phase: "success", done: true, repositoryModel: selection,
        ...(this.#activeTransferId ? { transferId: this.#activeTransferId } : {}) };
    }).catch((error: unknown) => {
      if (!this.#closed && !this.#closing) {
        this.#error = error instanceof LocalRuntimeError ? error.code : "RUNTIME_ERROR";
        if (selection) this.#lastTransfer = { name: selection.file, status: "error", phase: this.#error === "OPERATION_CANCELLED" ? "cancelled" : "error",
          done: true, repositoryModel: selection, publicErrorCode: this.#error,
          ...(this.#activeTransferId ? { transferId: this.#activeTransferId } : {}) };
      }
    }).finally(() => { if (this.#flight?.token === token) this.#flight = undefined; });
    this.#flight = { kind, token, task }; return this.snapshot();
  }
  async #requireCapability(capability: "canInstall" | "canStart" | "canPullModels" | "canConfigure" | "canStop" | "canRestart", signal?: AbortSignal): Promise<void> {
    this.#assertOwner(signal); const state = await this.snapshot(); this.#assertOwner(signal);
    if (state.capabilities[capability] !== true) throw unavailable();
  }
  #routes(): readonly ManagedRuntimeProviderRoute[] { return this.#options.providerRoutes().map(route => ({ ...route })); }
  async #validateTargets(targets: readonly ManagedRuntimeModelTarget[], signal?: AbortSignal): Promise<LlamaCppModel> {
    this.#assertOwner(signal); if (!targets.length || targets.length > 3) throw invalid();
    const state = await this.#options.manager.snapshot(this.#options.owner); this.#assertOwner(signal);
    const routes = this.#routes(), primary = targets[0]!, source = primary.repositoryModel;
    if (!source) throw invalid(); assertLlamaCppSelection(source);
    const models = state.models.filter(model => model.id === primary.modelId && sameSelection(model, source));
    const identities = new Set<string>();
    for (const target of targets) {
      const identity = `${target.backendId}\u001f${target.providerId}`;
      if (target.modelId !== primary.modelId || !sameSelection(target.repositoryModel, source)
        || routes.filter(route => route.backendId === target.backendId && route.providerId === target.providerId).length !== 1
        || identities.has(identity)) throw invalid();
      identities.add(identity);
    }
    if (models.length !== 1) throw new LocalRuntimeError("MODEL_NOT_FOUND", "The installed model is unavailable.");
    return models[0]!;
  }
  #context(value: ManagedRuntimeModelContext, targets: readonly ManagedRuntimeModelTarget[], model: LlamaCppModel): ManagedRuntimeModelContext {
    const target = targets[0]!;
    if (value.target.backendId !== target.backendId || value.target.providerId !== target.providerId || value.target.modelId !== target.modelId
      || !sameSelection(value.target.repositoryModel, target.repositoryModel)
      || value.defaultContextWindowTokens !== llamaCppContextSize(model) || value.maximumContextWindowTokens !== llamaCppMaximumContext(model)
      || [value.defaultContextWindowTokens, value.effectiveContextWindowTokens, value.maximumContextWindowTokens, ...value.presets]
        .some(limit => !Number.isSafeInteger(limit) || limit < 1000 || limit > value.maximumContextWindowTokens)) throw invalid();
    return value;
  }
  #assertOwner(signal?: AbortSignal): void {
    signal?.throwIfAborted(); const current = this.#options.currentOwner();
    if (this.#closed || this.#closing || !current || current.ownerId !== this.#options.owner.ownerId || current.generation !== this.#options.owner.generation) {
      throw new LocalRuntimeError("OWNER_CHANGED", "The managed runtime owner changed.");
    }
  }
}
function sameSelection(left: ManagedRepositoryModel | undefined, right: ManagedRepositoryModel | undefined): boolean {
  return !!left && !!right && left.repository === right.repository && left.file === right.file;
}
function invalid(): LocalRuntimeError { return new LocalRuntimeError("MODEL_INVALID", "The selected model source or route is invalid."); }
function unavailable(): LocalRuntimeError { return new LocalRuntimeError("MODEL_INCOMPATIBLE", "The selected runtime capability is unavailable."); }
