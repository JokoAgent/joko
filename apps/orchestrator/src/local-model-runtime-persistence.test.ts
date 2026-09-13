import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore, StaleGenerationError } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  StoreLocalModelProviderBindings,
  StorePausedPullRepository,
  StoreRuntimeInstallLeaseRepository,
  activateLocalModelRuntimePersistence
} from "./local-model-runtime-persistence.js";

const cleanups: Array<() => void> = [];
const owner = { ownerId: "owner-a", generation: 1 };

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Orchestrator local model runtime Store adapters", () => {
  it("round-trips resumable pull metadata through the owner-fenced Store", async () => {
    const { store } = fixture();
    activateLocalModelRuntimePersistence(store, owner, 100);
    const repository = new StorePausedPullRepository(store);
    await repository.put({
      ownerId: owner.ownerId,
      ownerGeneration: owner.generation,
      name: "model-a",
      completedBytes: 5,
      totalBytes: 10,
      percent: 50,
      digests: [`sha256:${"ab".repeat(32)}`],
      updatedAt: 200
    });
    await expect(repository.list(owner)).resolves.toEqual([
      expect.objectContaining({ name: "model-a", completedBytes: 5, percent: 50 })
    ]);
    await expect(repository.remove(owner, "model-a:latest")).resolves.toMatchObject({ name: "model-a" });
    await expect(repository.list(owner)).resolves.toEqual([]);
  });

  it("maps durable installation claims, completion and public failure codes", async () => {
    const { store } = fixture();
    activateLocalModelRuntimePersistence(store, owner, 100);
    const leases = new StoreRuntimeInstallLeaseRepository(store);
    await expect(leases.claim({ owner, operationId: "install-a", at: 200, leaseDurationMs: 30_000 }))
      .resolves.toMatchObject({ claimed: true, state: "installing" });
    await leases.heartbeat({ owner, operationId: "install-a", at: 1_000, leaseDurationMs: 30_000 });
    await leases.complete({
      owner,
      operationId: "install-a",
      version: "0.14.2",
      archiveSha256: "cd".repeat(32),
      at: 2_000
    });
    expect(store.findLocalRuntimeInstallation({ ownerId: owner.ownerId, runtimeId: "ollama", ownerGeneration: 1 }))
      .toMatchObject({ state: "installed", version: "0.14.2" });

    await expect(leases.claim({ owner, operationId: "install-b", at: 3_000, leaseDurationMs: 30_000 }))
      .resolves.toMatchObject({ claimed: true });
    await leases.fail({
      owner,
      operationId: "install-b",
      state: "failed",
      publicErrorCode: "CHECKSUM_MISMATCH",
      at: 4_000
    });
    expect(store.findLocalRuntimeInstallation({ ownerId: owner.ownerId, runtimeId: "ollama", ownerGeneration: 1 }))
      .toMatchObject({ state: "failed", publicErrorCode: "CHECKSUM_MISMATCH" });
  });

  it("persists Provider ownership without endpoint, credentials or prices", async () => {
    const { store } = fixture();
    activateLocalModelRuntimePersistence(store, owner, 100);
    const bindings = new StoreLocalModelProviderBindings(store);
    await bindings.put(owner, {
      providerId: "joko-local-ollama",
      providerVersion: 3n,
      modelIds: ["model-a", "model-b"]
    });
    await expect(bindings.find(owner)).resolves.toEqual({
      providerId: "joko-local-ollama",
      providerVersion: 3n,
      modelIds: ["model-a", "model-b"]
    });
    await bindings.remove(owner);
    await expect(bindings.find(owner)).resolves.toBeUndefined();
  });

  it("rejects adapter writes from an owner generation that has been superseded", async () => {
    const { store } = fixture();
    activateLocalModelRuntimePersistence(store, owner, 100);
    activateLocalModelRuntimePersistence(store, { ownerId: owner.ownerId, generation: 2 }, 200);
    const repository = new StorePausedPullRepository(store);
    await expect(repository.put({
      ownerId: owner.ownerId,
      ownerGeneration: owner.generation,
      name: "model-a",
      digests: [],
      updatedAt: 300
    })).rejects.toBeInstanceOf(StaleGenerationError);
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-runtime-persistence-"));
  const store = new OperationalStore(join(directory, "operational.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store };
}
