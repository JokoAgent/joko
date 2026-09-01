import { randomUUID } from "node:crypto";
import { totalmem } from "node:os";

import { ManagedSidecarArtifactCleaner, type CancelledPullArtifactCleaner } from "./artifact-cleaner.js";
import { curatedModelsForHost, modelPreflight, recommendedModelsForHost } from "./curated-catalog.js";
import { LocalRuntimeError, publicRuntimeError, pullError } from "./errors.js";
import { installManagedRuntime, runtimeInstallPreflight } from "./installer.js";
import { OllamaLoopbackClient } from "./ollama-client.js";
import { MemoryPausedPullRepository } from "./paused-pulls.js";
import { applyPullEvent, createTransferSpeedTracker } from "./progress.js";
import { assertActiveOwner, canonicalModelName, isSafeDigest, modelNamesEqual, normalizeOllamaModelName } from "./security.js";
import { OllamaRuntimeLauncher } from "./runtime-launcher.js";
import type {
  CuratedLocalModel,
  InstalledLocalModel,
  LocalRuntimeStatus,
  ManagedRuntimeModel,
  ModelPullProgress,
  OllamaPullEvent,
  PausedPullRepository,
  RuntimeAuditSink,
  RuntimeInstallProgress,
  RuntimeInstallLeaseRepository,
  RuntimePreflight,
  RuntimeOwnerGeneration
} from "./types.js";

type RuntimeInstaller = typeof installManagedRuntime;

interface ActivePull {
  readonly owner: RuntimeOwnerGeneration;
  readonly name: string;
  readonly abort: AbortController;
  readonly digests: Set<string>;
  readonly promise: Promise<void>;
  checkpointTail: Promise<void>;
  stopReason: "pause" | "cancel" | undefined;
  ownerChanged?: boolean;
  progress: ModelPullProgress;
}

export interface LocalModelRuntimeManagerOptions {
  readonly client: Pick<OllamaLoopbackClient, "tags" | "show" | "delete" | "pull">;
  readonly launcher: Pick<OllamaRuntimeLauncher, "status" | "start">;
  readonly dataRoot: string;
  readonly currentOwner: () => RuntimeOwnerGeneration | undefined;
  readonly pausedPulls?: PausedPullRepository;
  readonly artifactCleaner?: CancelledPullArtifactCleaner;
  readonly installer?: RuntimeInstaller;
  readonly installLeases?: RuntimeInstallLeaseRepository;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly totalMemory?: () => number;
  readonly now?: () => number;
  readonly onPullProgress?: (owner: RuntimeOwnerGeneration, progress: ModelPullProgress) => void;
  readonly onInstallProgress?: (owner: RuntimeOwnerGeneration, progress: RuntimeInstallProgress) => void;
  readonly onModelsChanged?: (owner: RuntimeOwnerGeneration, models: readonly ManagedRuntimeModel[]) => Promise<void>;
  readonly audit?: RuntimeAuditSink;
}

export class LocalModelRuntimeManager {
  private readonly pausedPulls: PausedPullRepository;
  private readonly artifactCleaner: CancelledPullArtifactCleaner;
  private readonly installer: RuntimeInstaller;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly totalMemory: () => number;
  private readonly now: () => number;
  private readonly activePullsByName = new Map<string, ActivePull>();
  private latestInstallProgress: { readonly owner: RuntimeOwnerGeneration; readonly progress: RuntimeInstallProgress } | undefined;
  private installOperation: { readonly owner: RuntimeOwnerGeneration; readonly abort: AbortController; readonly promise: Promise<LocalRuntimeStatus> } | undefined;
  private startOperation: { readonly owner: RuntimeOwnerGeneration; readonly promise: Promise<LocalRuntimeStatus> } | undefined;

  constructor(private readonly options: LocalModelRuntimeManagerOptions) {
    this.pausedPulls = options.pausedPulls ?? new MemoryPausedPullRepository();
    this.artifactCleaner = options.artifactCleaner ?? new ManagedSidecarArtifactCleaner(options.dataRoot);
    this.installer = options.installer ?? installManagedRuntime;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.totalMemory = options.totalMemory ?? totalmem;
    this.now = options.now ?? Date.now;
  }

  async status(owner: RuntimeOwnerGeneration): Promise<LocalRuntimeStatus> {
    this.assertOwner(owner);
    const status = await this.options.launcher.status(owner);
    this.assertOwner(owner);
    return status;
  }

  curated(owner: RuntimeOwnerGeneration): { readonly catalog: readonly CuratedLocalModel[]; readonly recommended: readonly CuratedLocalModel[] } {
    this.assertOwner(owner);
    const input = { platform: this.platform, arch: this.arch, totalMemoryBytes: this.totalMemory() };
    return { catalog: curatedModelsForHost(input), recommended: recommendedModelsForHost(input) };
  }

  runtimePreflight(owner: RuntimeOwnerGeneration, freeDiskBytes?: number): RuntimePreflight {
    this.assertOwner(owner);
    return runtimeInstallPreflight({
      platform: this.platform,
      arch: this.arch,
      ...(freeDiskBytes === undefined ? {} : { freeDiskBytes })
    });
  }

  modelPreflight(owner: RuntimeOwnerGeneration, catalogId: string, freeDiskBytes?: number): RuntimePreflight {
    this.assertOwner(owner);
    const catalog = this.curated(owner).catalog;
    const model = catalog.find((item) => item.id === catalogId);
    if (model === undefined) throw new LocalRuntimeError("MODEL_NOT_FOUND", "The curated model could not be found.");
    return modelPreflight({
      model,
      platform: this.platform,
      arch: this.arch,
      totalMemoryBytes: this.totalMemory(),
      ...(freeDiskBytes === undefined ? {} : { freeDiskBytes })
    });
  }

  installProgress(owner: RuntimeOwnerGeneration): RuntimeInstallProgress | undefined {
    this.assertOwner(owner);
    return this.latestInstallProgress !== undefined && sameOwner(this.latestInstallProgress.owner, owner)
      ? this.latestInstallProgress.progress
      : undefined;
  }

  async start(owner: RuntimeOwnerGeneration, signal?: AbortSignal): Promise<LocalRuntimeStatus> {
    this.assertOwner(owner);
    if (this.startOperation !== undefined) {
      if (!sameOwner(this.startOperation.owner, owner)) throw new LocalRuntimeError("START_FAILED", "Another runtime owner is starting the service.");
      return this.startOperation.promise;
    }
    this.audit(owner, "runtime_start", "started");
    const promise = this.options.launcher.start({ owner, currentOwner: this.options.currentOwner, signal })
      .then((status) => {
        this.assertOwner(owner);
        this.audit(owner, "runtime_start", "succeeded");
        return status;
      })
      .catch((error) => {
        const publicError = this.ownerStillActive(owner)
          ? publicRuntimeError(error)
          : new LocalRuntimeError("OWNER_CHANGED", "The runtime owner changed during the operation.");
        this.audit(owner, "runtime_start", publicError.code === "OPERATION_CANCELLED" ? "cancelled" : "failed", undefined, publicError.code);
        throw publicError;
      })
      .finally(() => {
        if (this.startOperation?.promise === promise) this.startOperation = undefined;
      });
    this.startOperation = { owner, promise };
    return promise;
  }

  async install(owner: RuntimeOwnerGeneration): Promise<LocalRuntimeStatus> {
    this.assertOwner(owner);
    if (this.installOperation !== undefined) {
      if (!sameOwner(this.installOperation.owner, owner)) throw new LocalRuntimeError("INSTALL_BUSY", "Another runtime owner is installing the service.");
      return this.installOperation.promise;
    }
    const abort = new AbortController();
    const operationId = randomUUID();
    const leaseDurationMs = 30_000;
    let leaseClaimed = false;
    let promoted = false;
    let leaseFailure: unknown;
    let leaseTail = Promise.resolve();
    let lastHeartbeatAt = 0;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const heartbeat = (force = false) => {
      const leases = this.options.installLeases;
      if (leases === undefined || !leaseClaimed || leaseFailure !== undefined) return;
      const at = this.now();
      if (!force && at - lastHeartbeatAt < 10_000) return;
      lastHeartbeatAt = at;
      leaseTail = leaseTail.then(() => leases.heartbeat({ owner, operationId, at, leaseDurationMs })).catch((error) => {
        leaseFailure = error;
        abort.abort();
      });
    };
    this.audit(owner, "runtime_install", "started");
    let promise!: Promise<LocalRuntimeStatus>;
    promise = (async () => {
      try {
        if (this.options.installLeases !== undefined) {
          const claim = await this.options.installLeases.claim({
            owner,
            operationId,
            at: this.now(),
            leaseDurationMs
          });
          if (!claim.claimed) throw new LocalRuntimeError("INSTALL_BUSY", "The local runtime installation is already claimed.");
          leaseClaimed = true;
          lastHeartbeatAt = this.now();
          heartbeatTimer = setInterval(() => heartbeat(true), 10_000);
          heartbeatTimer.unref?.();
        }
        const installed = await this.installer({
          dataRoot: this.options.dataRoot,
          platform: this.platform,
          arch: this.arch,
          signal: abort.signal,
          onProgress: (progress) => {
            try {
              this.assertOwner(owner);
              heartbeat();
              this.publishInstallProgress(owner, progress);
            } catch {
              abort.abort();
            }
          }
        });
        await leaseTail;
        if (leaseFailure !== undefined) throw leaseFailure;
        this.assertOwner(owner);
        if (this.options.installLeases !== undefined) {
          await this.options.installLeases.complete({
            owner,
            operationId,
            version: installed.version,
            archiveSha256: installed.archiveSha256,
            at: this.now()
          });
        }
        promoted = true;
        this.publishInstallProgress(owner, { phase: "starting", done: false });
        const status = await this.options.launcher.start({ owner, currentOwner: this.options.currentOwner, signal: abort.signal });
        this.assertOwner(owner);
        this.publishInstallProgress(owner, { phase: "success", percent: 100, done: true });
        this.audit(owner, "runtime_install", "succeeded");
        return status;
      } catch (error) {
        const publicError = this.ownerStillActive(owner)
          ? publicRuntimeError(error)
          : new LocalRuntimeError("OWNER_CHANGED", "The runtime owner changed during the operation.");
        const cancelled = publicError.code === "OPERATION_CANCELLED";
        if (this.options.installLeases !== undefined && leaseClaimed && !promoted) {
          await leaseTail.catch(() => undefined);
          await this.options.installLeases.fail({
            owner,
            operationId,
            state: cancelled ? "cancelled" : "failed",
            publicErrorCode: publicError.code,
            at: this.now()
          }).catch(() => undefined);
        }
        this.publishInstallProgress(owner, { phase: cancelled ? "cancelled" : "error", done: true, publicErrorCode: publicError.code });
        this.audit(owner, "runtime_install", cancelled ? "cancelled" : "failed", undefined, publicError.code);
        throw publicError;
      } finally {
        if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
        if (this.installOperation?.promise === promise) this.installOperation = undefined;
      }
    })();
    this.installOperation = { owner, abort, promise };
    return promise;
  }

  abortInstall(owner: RuntimeOwnerGeneration): void {
    this.assertOwner(owner);
    if (this.installOperation !== undefined && sameOwner(this.installOperation.owner, owner)) this.installOperation.abort.abort();
  }

  async list(owner: RuntimeOwnerGeneration, signal?: AbortSignal): Promise<readonly InstalledLocalModel[]> {
    this.assertOwner(owner);
    const status = await this.options.launcher.status(owner);
    if (status.state !== "ready") return [];
    const tags = await this.options.client.tags(signal);
    const models = await Promise.all(tags.map(async (tag): Promise<InstalledLocalModel> => {
      try {
        const details = await this.options.client.show(tag.name, signal);
        return { ...tag, ...details };
      } catch {
        return { ...tag, capabilities: [] };
      }
    }));
    this.assertOwner(owner);
    await this.syncModels(owner, models);
    return models;
  }

  async paused(owner: RuntimeOwnerGeneration): Promise<readonly ModelPullProgress[]> {
    this.assertOwner(owner);
    const records = await this.pausedPulls.list(owner);
    this.assertOwner(owner);
    return records.map((record) => ({
      name: record.name,
      phase: "paused",
      status: "paused",
      ...(record.completedBytes === undefined ? {} : { completedBytes: record.completedBytes }),
      ...(record.totalBytes === undefined ? {} : { totalBytes: record.totalBytes }),
      ...(record.percent === undefined ? {} : { percent: record.percent }),
      done: true
    }));
  }

  activePulls(owner: RuntimeOwnerGeneration): readonly ModelPullProgress[] {
    this.assertOwner(owner);
    return [...this.activePullsByName.values()].filter((pull) => sameOwner(pull.owner, owner)).map((pull) => pull.progress);
  }

  pull(owner: RuntimeOwnerGeneration, requestedName: string): Promise<void> {
    this.assertOwner(owner);
    const name = normalizeOllamaModelName(requestedName);
    const key = canonicalModelName(name);
    const existing = this.activePullsByName.get(key);
    if (existing !== undefined) {
      if (!sameOwner(existing.owner, owner)) return Promise.reject(new LocalRuntimeError("PULL_BUSY", "The model is being pulled by another runtime owner."));
      return existing.promise;
    }
    const abort = new AbortController();
    const digests = new Set<string>();
    const initial: ModelPullProgress = { name, phase: "starting", status: "starting", done: false };
    const active: ActivePull = {
      owner,
      name,
      abort,
      digests,
      promise: Promise.resolve(),
      checkpointTail: Promise.resolve(),
      stopReason: undefined,
      ownerChanged: false,
      progress: initial
    };
    this.activePullsByName.set(key, active);
    const promise = this.runPull({ owner, name, key, abort, digests, getActive: () => active })
      .finally(() => {
        if (this.activePullsByName.get(key) === active) this.activePullsByName.delete(key);
      });
    (active as { promise: Promise<void> }).promise = promise;
    return promise;
  }

  async pause(owner: RuntimeOwnerGeneration, name: string): Promise<void> {
    await this.stopPull(owner, name, "pause");
  }

  async resume(owner: RuntimeOwnerGeneration, name: string): Promise<void> {
    this.assertOwner(owner);
    await this.pull(owner, name);
  }

  async cancel(owner: RuntimeOwnerGeneration, name: string): Promise<void> {
    const stopped = await this.stopPull(owner, name, "cancel");
    if (!stopped) {
      const normalized = normalizeOllamaModelName(name);
      const record = await this.pausedPulls.remove(owner, normalized);
      await this.cleanupCancelled(owner, normalized, record?.digests ?? []);
    }
  }

  /** Preserve resumable checkpoints while fencing every in-flight process-owned operation. */
  async shutdown(owner: RuntimeOwnerGeneration): Promise<void> {
    this.assertOwner(owner);
    if (this.installOperation !== undefined && sameOwner(this.installOperation.owner, owner)) {
      this.installOperation.abort.abort();
    }
    const pulls = [...this.activePullsByName.values()].filter((pull) => sameOwner(pull.owner, owner));
    for (const pull of pulls) {
      pull.stopReason = "pause";
      pull.abort.abort();
    }
    await Promise.allSettled([
      ...(this.installOperation === undefined ? [] : [this.installOperation.promise]),
      ...pulls.map((pull) => pull.promise)
    ]);
  }

  async delete(owner: RuntimeOwnerGeneration, requestedName: string): Promise<void> {
    this.assertOwner(owner);
    const name = normalizeOllamaModelName(requestedName);
    const active = this.activePullsByName.get(canonicalModelName(name));
    if (active !== undefined) throw new LocalRuntimeError("PULL_BUSY", "The model cannot be deleted while it is downloading.");
    await this.options.client.delete(name);
    await this.pausedPulls.remove(owner, name);
    this.assertOwner(owner);
    await this.syncInstalled(owner);
    this.audit(owner, "model_delete", "succeeded", name);
  }

  private async runPull(input: {
    readonly owner: RuntimeOwnerGeneration;
    readonly name: string;
    readonly key: string;
    readonly abort: AbortController;
    readonly digests: Set<string>;
    readonly getActive: () => ActivePull;
  }): Promise<void> {
    const { owner, name, abort, digests } = input;
    this.audit(owner, "model_pull", "started", name);
    const layers = new Map<string, { readonly completed: number; readonly total: number }>();
    const speed = createTransferSpeedTracker();
    let checkpointAt = 0;
    const checkpoint = async (progress: ModelPullProgress, force = false) => {
      if (!force && this.now() - checkpointAt < 1_000) return;
      checkpointAt = this.now();
      const active = input.getActive();
      active.checkpointTail = active.checkpointTail.then(() => this.pausedPulls.put({
          ownerId: owner.ownerId,
          ownerGeneration: owner.generation,
          name,
          ...(progress.completedBytes === undefined ? {} : { completedBytes: progress.completedBytes }),
          ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
          ...(progress.percent === undefined ? {} : { percent: progress.percent }),
          digests: [...digests],
          updatedAt: this.now()
        }));
      if (force) await active.checkpointTail;
    };
    try {
      this.assertOwner(owner);
      await checkpoint(input.getActive().progress, true);
      const tags = await this.options.client.tags(abort.signal).catch(() => []);
      if (!tags.some((tag) => modelNamesEqual(tag.name, name))) {
        await this.options.client.pull(name, (event: OllamaPullEvent) => {
          if (event.digest !== undefined && isSafeDigest(event.digest)) digests.add(event.digest.toLowerCase());
          try {
            this.assertOwner(owner);
          } catch {
            input.getActive().ownerChanged = true;
            abort.abort();
            return;
          }
          const progress = applyPullEvent(name, layers, event, speed);
          input.getActive().progress = progress;
          this.options.onPullProgress?.(owner, progress);
          void checkpoint(progress).catch(() => undefined);
        }, abort.signal);
      }
      this.assertOwner(owner);
      await this.syncInstalled(owner);
      await input.getActive().checkpointTail;
      await this.pausedPulls.remove(owner, name);
      const success: ModelPullProgress = { name, phase: "success", status: "success", percent: 100, done: true };
      input.getActive().progress = success;
      this.options.onPullProgress?.(owner, success);
      this.audit(owner, "model_pull", "succeeded", name);
    } catch (error) {
      const active = input.getActive();
      if (active.ownerChanged === true || !this.ownerStillActive(owner)) {
        const changed = new LocalRuntimeError("OWNER_CHANGED", "The runtime owner changed during the operation.");
        this.audit(owner, "model_pull", "failed", name, changed.code);
        throw changed;
      }
      const reason = active.stopReason;
      if (reason !== undefined) {
        const stopped: ModelPullProgress = { ...active.progress, phase: reason === "pause" ? "paused" : "cancelled", status: reason, done: true, bytesPerSecond: undefined };
        active.progress = stopped;
        this.options.onPullProgress?.(owner, stopped);
        if (reason === "pause") await checkpoint(stopped, true);
        else {
          await active.checkpointTail;
          await this.pausedPulls.remove(owner, name);
          await this.cleanupCancelled(owner, name, [...digests]);
        }
        this.audit(owner, "model_pull", "cancelled", name, "OPERATION_CANCELLED");
        throw new LocalRuntimeError("OPERATION_CANCELLED", reason === "pause" ? "The model pull was paused." : "The model pull was cancelled.");
      }
      const safe = pullError(error, name);
      const failed: ModelPullProgress = { name, phase: "error", status: "error", done: true, publicErrorCode: safe.code };
      active.progress = failed;
      this.options.onPullProgress?.(owner, failed);
      this.audit(owner, "model_pull", "failed", name, safe.code);
      throw safe;
    }
  }

  private async stopPull(owner: RuntimeOwnerGeneration, requestedName: string, reason: "pause" | "cancel"): Promise<boolean> {
    this.assertOwner(owner);
    const name = normalizeOllamaModelName(requestedName);
    const active = this.activePullsByName.get(canonicalModelName(name));
    if (active === undefined) return false;
    if (!sameOwner(active.owner, owner)) throw new LocalRuntimeError("PULL_BUSY", "The model pull belongs to another runtime owner.");
    active.stopReason = reason;
    active.abort.abort();
    await active.promise.catch(() => undefined);
    return true;
  }

  private async cleanupCancelled(owner: RuntimeOwnerGeneration, name: string, digests: readonly string[]): Promise<void> {
    let installed = true;
    try {
      const tags = await this.options.client.tags();
      installed = tags.some((tag) => modelNamesEqual(tag.name, name));
    } catch {
      installed = true;
    }
    if (!installed) await this.options.client.delete(name).catch(() => undefined);
    const keepDigests = new Set<string>();
    for (const active of this.activePullsByName.values()) {
      if (modelNamesEqual(active.name, name)) continue;
      for (const digest of active.digests) keepDigests.add(digest);
    }
    for (const paused of await this.pausedPulls.list(owner)) {
      if (modelNamesEqual(paused.name, name)) continue;
      for (const digest of paused.digests) keepDigests.add(digest);
    }
    await this.artifactCleaner.cleanup({ digests, keepDigests });
  }

  private async syncInstalled(owner: RuntimeOwnerGeneration): Promise<void> {
    const tags = await this.options.client.tags();
    const models = await Promise.all(tags.map(async (tag): Promise<InstalledLocalModel> => {
      try {
        return { ...tag, ...await this.options.client.show(tag.name) };
      } catch {
        return { ...tag, capabilities: [] };
      }
    }));
    this.assertOwner(owner);
    await this.syncModels(owner, models);
  }

  private async syncModels(owner: RuntimeOwnerGeneration, models: readonly InstalledLocalModel[]): Promise<void> {
    if (this.options.onModelsChanged === undefined) return;
    const projected = models.map((model): ManagedRuntimeModel => ({
      id: model.name,
      displayName: model.name,
      ...(model.contextLength === undefined ? {} : { contextWindow: model.contextLength }),
      supportsTools: model.capabilities.some((value) => value.toLowerCase() === "tools"),
      supportsImages: model.capabilities.some((value) => ["vision", "images", "image"].includes(value.toLowerCase()))
    }));
    await this.options.onModelsChanged(owner, projected);
    this.assertOwner(owner);
    this.audit(owner, "model_sync", "succeeded");
  }

  private assertOwner(owner: RuntimeOwnerGeneration): void {
    assertActiveOwner(owner, this.options.currentOwner);
  }

  private ownerStillActive(owner: RuntimeOwnerGeneration): boolean {
    const active = this.options.currentOwner();
    return active?.ownerId === owner.ownerId && active.generation === owner.generation;
  }

  private audit(
    owner: RuntimeOwnerGeneration,
    code: Parameters<NonNullable<LocalModelRuntimeManagerOptions["audit"]>>[0]["code"],
    outcome: Parameters<NonNullable<LocalModelRuntimeManagerOptions["audit"]>>[0]["outcome"],
    modelName?: string,
    publicErrorCode?: Parameters<NonNullable<LocalModelRuntimeManagerOptions["audit"]>>[0]["publicErrorCode"]
  ): void {
    this.options.audit?.({
      code,
      outcome,
      ownerId: owner.ownerId,
      ownerGeneration: owner.generation,
      ...(modelName === undefined ? {} : { modelName }),
      ...(publicErrorCode === undefined ? {} : { publicErrorCode })
    });
  }

  private publishInstallProgress(owner: RuntimeOwnerGeneration, progress: RuntimeInstallProgress): void {
    this.latestInstallProgress = { owner, progress };
    this.options.onInstallProgress?.(owner, progress);
  }
}

function sameOwner(left: RuntimeOwnerGeneration, right: RuntimeOwnerGeneration): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation;
}
