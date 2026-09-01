import {
  canonicalModelName,
  type PausedModelPull,
  type PausedPullRepository,
  type RuntimeInstallLeaseRepository,
  type RuntimeOwnerGeneration
} from "@joko/local-model-runtime";
import type { OperationalStore } from "@joko/store";

import type {
  LocalModelProviderBinding,
  LocalModelProviderBindings
} from "./local-model-runtime-coordinator.js";

export const LOCAL_MODEL_RUNTIME_ID = "ollama";

function scope(owner: RuntimeOwnerGeneration) {
  return {
    ownerId: owner.ownerId,
    runtimeId: LOCAL_MODEL_RUNTIME_ID,
    ownerGeneration: owner.generation
  };
}

/** Must run when Orchestrator accepts a new active data-owner generation. */
export function activateLocalModelRuntimePersistence(
  store: OperationalStore,
  owner: RuntimeOwnerGeneration,
  activatedAt?: number
): void {
  store.activateLocalRuntimeOwner({
    ...scope(owner),
    ...(activatedAt === undefined ? {} : { activatedAt })
  });
}

export class StorePausedPullRepository implements PausedPullRepository {
  constructor(private readonly store: OperationalStore) {}

  async list(owner: RuntimeOwnerGeneration): Promise<readonly PausedModelPull[]> {
    return this.store.listLocalModelPullCheckpoints(scope(owner)).map((record) => ({
      ownerId: record.ownerId,
      ownerGeneration: record.ownerGeneration,
      name: record.modelName,
      ...(record.completedBytes === undefined ? {} : { completedBytes: record.completedBytes }),
      ...(record.totalBytes === undefined ? {} : { totalBytes: record.totalBytes }),
      ...(record.percent === undefined ? {} : { percent: record.percent }),
      digests: record.digests,
      updatedAt: record.updatedAt
    }));
  }

  async put(record: PausedModelPull): Promise<void> {
    this.store.putLocalModelPullCheckpoint({
      ...scope({ ownerId: record.ownerId, generation: record.ownerGeneration }),
      modelKey: canonicalModelName(record.name),
      modelName: record.name,
      ...(record.completedBytes === undefined ? {} : { completedBytes: record.completedBytes }),
      ...(record.totalBytes === undefined ? {} : { totalBytes: record.totalBytes }),
      ...(record.percent === undefined ? {} : { percent: record.percent }),
      digests: record.digests,
      updatedAt: record.updatedAt
    });
  }

  async remove(owner: RuntimeOwnerGeneration, name: string): Promise<PausedModelPull | undefined> {
    const record = this.store.removeLocalModelPullCheckpoint(scope(owner), canonicalModelName(name));
    return record === undefined ? undefined : {
      ownerId: record.ownerId,
      ownerGeneration: record.ownerGeneration,
      name: record.modelName,
      ...(record.completedBytes === undefined ? {} : { completedBytes: record.completedBytes }),
      ...(record.totalBytes === undefined ? {} : { totalBytes: record.totalBytes }),
      ...(record.percent === undefined ? {} : { percent: record.percent }),
      digests: record.digests,
      updatedAt: record.updatedAt
    };
  }
}

export class StoreRuntimeInstallLeaseRepository implements RuntimeInstallLeaseRepository {
  constructor(private readonly store: OperationalStore) {}

  async claim(input: Parameters<RuntimeInstallLeaseRepository["claim"]>[0]) {
    const claim = this.store.claimLocalRuntimeInstallation({
      ...scope(input.owner),
      operationId: input.operationId,
      at: input.at,
      leaseDurationMs: input.leaseDurationMs
    });
    return {
      claimed: claim.claimed,
      recovered: claim.recovered,
      state: claim.record.state
    };
  }

  async heartbeat(input: Parameters<RuntimeInstallLeaseRepository["heartbeat"]>[0]): Promise<void> {
    this.store.heartbeatLocalRuntimeInstallation({
      ...scope(input.owner),
      operationId: input.operationId,
      at: input.at,
      leaseDurationMs: input.leaseDurationMs
    });
  }

  async complete(input: Parameters<RuntimeInstallLeaseRepository["complete"]>[0]): Promise<void> {
    this.store.completeLocalRuntimeInstallation({
      ...scope(input.owner),
      operationId: input.operationId,
      version: input.version,
      archiveSha256: input.archiveSha256,
      at: input.at
    });
  }

  async fail(input: Parameters<RuntimeInstallLeaseRepository["fail"]>[0]): Promise<void> {
    this.store.failLocalRuntimeInstallation({
      ...scope(input.owner),
      operationId: input.operationId,
      state: input.state,
      publicErrorCode: input.publicErrorCode,
      at: input.at
    });
  }
}

export class StoreLocalModelProviderBindings implements LocalModelProviderBindings {
  constructor(private readonly store: OperationalStore) {}

  async find(owner: RuntimeOwnerGeneration): Promise<LocalModelProviderBinding | undefined> {
    const record = this.store.findLocalRuntimeProviderBinding(scope(owner));
    return record === undefined ? undefined : {
      providerId: record.providerId,
      providerVersion: record.providerVersion,
      modelIds: record.modelIds
    };
  }

  async put(owner: RuntimeOwnerGeneration, binding: LocalModelProviderBinding): Promise<void> {
    this.store.putLocalRuntimeProviderBinding({
      ...scope(owner),
      providerId: binding.providerId,
      providerVersion: binding.providerVersion,
      modelIds: binding.modelIds
    });
  }

  async remove(owner: RuntimeOwnerGeneration): Promise<void> {
    this.store.removeLocalRuntimeProviderBinding(scope(owner));
  }
}
