import {
  LocalRuntimeError,
  type CuratedLocalModel,
  type LocalRuntimeStatus,
  type ModelPullProgress,
  type RuntimeInstallProgress,
  type RuntimeOwnerGeneration,
  type RuntimePreflight
} from "@joko/local-model-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  ManagedModelRuntimeController,
  managedModelRuntimeErrorMessage,
  type ManagedModelRuntimeManagerPort
} from "./managed-model-runtime-controller.js";

const owner = { ownerId: "orchestrator-a", generation: 7 } as const;

class FakeRuntimeManager implements ManagedModelRuntimeManagerPort {
  currentStatus: LocalRuntimeStatus = {
    runtime: "ollama",
    state: "ready",
    source: "running",
    version: "0.14.2",
    capabilities: {
      canInstall: true,
      canStart: true,
      canListModels: true,
      canPullModels: true,
      canDeleteModels: true,
      canPausePulls: true
    }
  };
  installed = [{ name: "installed:latest", sizeBytes: 10, contextLength: 8192, capabilities: ["tools"] }];
  pausedValues: ModelPullProgress[] = [];
  activeValues: ModelPullProgress[] = [];
  installValue: RuntimeInstallProgress | undefined;
  pullDeferred = deferred<void>();
  readonly pulls = vi.fn();
  readonly deletes = vi.fn();
  readonly shutdowns = vi.fn();

  async status(_owner: RuntimeOwnerGeneration) { return this.currentStatus; }
  curated(_owner: RuntimeOwnerGeneration) {
    const model: CuratedLocalModel = {
      id: "recommended-a",
      displayName: "Recommended A",
      libraryName: "recommended:a",
      aliases: ["recommended"],
      sizeBytes: 1_024,
      minimumMemoryGb: 8,
      appleSiliconOnly: false
    };
    return { catalog: [model], recommended: [model] };
  }
  runtimePreflight(_owner: RuntimeOwnerGeneration, _freeDiskBytes?: number): RuntimePreflight {
    return { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 2_048 };
  }
  modelPreflight(_owner: RuntimeOwnerGeneration, _catalogId: string, _freeDiskBytes?: number): RuntimePreflight {
    return { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 2_048 };
  }
  installProgress(_owner: RuntimeOwnerGeneration) { return this.installValue; }
  async list(_owner: RuntimeOwnerGeneration) { return this.installed; }
  async paused(_owner: RuntimeOwnerGeneration) { return this.pausedValues; }
  activePulls(_owner: RuntimeOwnerGeneration) { return this.activeValues; }
  async start(_owner: RuntimeOwnerGeneration, _signal?: AbortSignal) { return this.currentStatus; }
  async install(_owner: RuntimeOwnerGeneration) { return this.currentStatus; }
  abortInstall(_owner: RuntimeOwnerGeneration) {}
  pull(_owner: RuntimeOwnerGeneration, modelName: string): Promise<void> {
    this.pulls(modelName);
    this.activeValues = [{ name: modelName, phase: "downloading", status: "downloading", percent: 25, done: false }];
    return this.pullDeferred.promise.finally(() => { this.activeValues = []; });
  }
  async pause(_owner: RuntimeOwnerGeneration, modelName: string): Promise<void> {
    this.pausedValues = [{ name: modelName, phase: "paused", status: "paused", percent: 25, done: true }];
    this.pullDeferred.resolve();
  }
  resume(ownerValue: RuntimeOwnerGeneration, modelName: string): Promise<void> {
    this.pausedValues = [];
    this.pullDeferred = deferred<void>();
    return this.pull(ownerValue, modelName);
  }
  async cancel(_owner: RuntimeOwnerGeneration, _modelName: string): Promise<void> {
    this.pausedValues = [];
    this.pullDeferred.resolve();
  }
  async delete(_owner: RuntimeOwnerGeneration, modelName: string): Promise<void> {
    this.deletes(modelName);
    this.installed = this.installed.filter((model) => model.name !== modelName);
  }
  async shutdown(ownerValue: RuntimeOwnerGeneration): Promise<void> { this.shutdowns(ownerValue); }
}

describe("ManagedModelRuntimeController", () => {
  it("projects installed, curated and resumable state entirely through capabilities", async () => {
    const manager = new FakeRuntimeManager();
    const controller = new ManagedModelRuntimeController({ manager, owner, freeDiskBytes: async () => 50_000, now: () => 100 });
    const snapshot = await controller.snapshot();
    expect(snapshot).toMatchObject({
      runtimeId: "ollama",
      state: "ready",
      version: "0.14.2",
      capabilities: {
        canInstall: true,
        canPullModels: true,
        supportsCustomModels: true,
        supportsCuratedCatalog: true,
        supportsModelPreflight: true
      },
      installPreflight: { allowed: true },
      installedModels: [{ name: "installed:latest" }],
      catalog: [{ id: "recommended-a", recommended: true, preflight: { allowed: true } }]
    });
    expect(snapshot.revision).toBe(1n);
    expect((await controller.snapshot()).revision).toBe(1n);
  });

  it("starts pulls without tying them to the request and exposes pause, resume and cancel", async () => {
    const manager = new FakeRuntimeManager();
    const controller = new ManagedModelRuntimeController({ manager, owner });
    const pulling = await controller.beginPull("recommended:a");
    expect(pulling.transfers).toEqual([expect.objectContaining({ name: "recommended:a", percent: 25 })]);
    expect(manager.pulls).toHaveBeenCalledTimes(1);

    const joined = await controller.beginPull("recommended:a");
    expect(joined.transfers).toHaveLength(1);
    expect(manager.pulls).toHaveBeenCalledTimes(1);

    const paused = await controller.pausePull("recommended:a");
    expect(paused.transfers).toEqual([expect.objectContaining({ phase: "paused" })]);
    expect(paused.capabilities.canResumePulls).toBe(true);

    const resumed = await controller.resumePull("recommended:a");
    expect(resumed.transfers).toEqual([expect.objectContaining({ phase: "downloading" })]);
    await controller.cancelPull("recommended:a");
    expect((await controller.snapshot()).transfers).toEqual([]);
  });

  it("fails closed on model preflight and exposes only stable public errors", async () => {
    const manager = new FakeRuntimeManager();
    manager.modelPreflight = () => ({
      allowed: false,
      memory: "sufficient",
      disk: "insufficient",
      requiredDiskBytes: 9_000,
      publicErrorCode: "DISK_SPACE_LOW"
    });
    const controller = new ManagedModelRuntimeController({ manager, owner });
    await expect(controller.beginPull("recommended:a")).rejects.toMatchObject({ code: "DISK_SPACE_LOW" });
    expect(managedModelRuntimeErrorMessage("DISK_SPACE_LOW")).toBe("There is not enough free disk space for this operation.");
  });

  it("preserves active downloads as paused metadata during owner shutdown", async () => {
    const manager = new FakeRuntimeManager();
    const controller = new ManagedModelRuntimeController({ manager, owner });
    await controller.close();
    expect(manager.shutdowns).toHaveBeenCalledWith(owner);
    await expect(controller.snapshot()).rejects.toMatchObject({ code: "OWNER_CHANGED" });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}
