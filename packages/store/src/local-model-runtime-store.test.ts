import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationalStore,
  OperationInProgressError,
  StaleGenerationError,
  StoreError
} from "./index.js";

const cleanups: Array<() => void> = [];
const DIGEST_A = `sha256:${"ab".repeat(32)}`;
const DIGEST_B = `sha256:${"cd".repeat(32)}`;

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("managed local model runtime persistence", () => {
  it("persists the path-free control plane across restart", () => {
    const fixture = createFixture();
    const owner = fixture.store.activateLocalRuntimeOwner(scope(1));
    fixture.store.putLocalModelPullCheckpoint({
      ...scope(1),
      modelKey: "model-a:latest",
      modelName: "model-a",
      completedBytes: 5,
      totalBytes: 10,
      percent: 50,
      digests: [DIGEST_A],
      updatedAt: 2_000
    });
    fixture.store.putLocalRuntimeProviderBinding({
      ...scope(1),
      providerId: "joko-local-ollama",
      providerVersion: 4n,
      modelIds: ["model-a"],
      updatedAt: 2_001
    });
    expect(owner).toMatchObject({ ownerId: "owner-a", runtimeId: "ollama", ownerGeneration: 1 });

    const reopened = fixture.reopen();
    expect(reopened.listLocalModelPullCheckpoints(scope(1))).toEqual([
      expect.objectContaining({ modelKey: "model-a:latest", completedBytes: 5, digests: [DIGEST_A] })
    ]);
    expect(reopened.findLocalRuntimeProviderBinding(scope(1))).toMatchObject({
      providerId: "joko-local-ollama",
      providerVersion: 4n,
      modelIds: ["model-a"]
    });

    fixture.close();
    const database = new DatabaseSync(fixture.filePath);
    try {
      for (const table of [
        "local_runtime_owners",
        "local_runtime_installations",
        "local_model_pull_checkpoints",
        "local_runtime_provider_bindings"
      ]) {
        const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
          .map((row) => String(row["name"]));
        expect(columns.some((column) => /path|url|credential|secret|token|header|environment/iu.test(column))).toBe(false);
      }
    } finally {
      database.close();
    }
  });

  it("single-flights installation, heartbeats a lease and recovers expiry", () => {
    const { store } = createFixture();
    store.activateLocalRuntimeOwner(scope(1));
    const first = store.claimLocalRuntimeInstallation({
      ...scope(1), operationId: "install-1", at: 10_000, leaseDurationMs: 2_000
    });
    expect(first).toMatchObject({ claimed: true, recovered: false, record: { state: "installing", leaseExpiresAt: 12_000 } });
    expect(store.claimLocalRuntimeInstallation({
      ...scope(1), operationId: "install-1", at: 10_100, leaseDurationMs: 2_000
    })).toMatchObject({ claimed: false, recovered: false });
    expect(() => store.claimLocalRuntimeInstallation({
      ...scope(1), operationId: "install-2", at: 11_999, leaseDurationMs: 2_000
    })).toThrow(OperationInProgressError);

    const recovered = store.claimLocalRuntimeInstallation({
      ...scope(1), operationId: "install-2", at: 12_000, leaseDurationMs: 3_000
    });
    expect(recovered).toMatchObject({ claimed: true, recovered: true, record: { operationId: "install-2", leaseExpiresAt: 15_000 } });
    expect(store.heartbeatLocalRuntimeInstallation({
      ...scope(1), operationId: "install-2", at: 14_000, leaseDurationMs: 3_000
    })).toMatchObject({ heartbeatAt: 14_000, leaseExpiresAt: 17_000 });
    const installed = store.completeLocalRuntimeInstallation({
      ...scope(1), operationId: "install-2", version: "0.14.2", archiveSha256: "ef".repeat(32), at: 15_000
    });
    expect(installed).toMatchObject({ state: "installed", version: "0.14.2", archiveSha256: "ef".repeat(32) });
    expect(installed).not.toHaveProperty("publicErrorCode");
    expect(store.claimLocalRuntimeInstallation({
      ...scope(1), operationId: "install-2", at: 16_000, leaseDurationMs: 3_000
    })).toMatchObject({ claimed: false, record: { state: "installed" } });
  });

  it("adopts resumable metadata but fences every late old-generation write", () => {
    const { store } = createFixture();
    store.activateLocalRuntimeOwner(scope(1));
    store.putLocalModelPullCheckpoint({
      ...scope(1), modelKey: "model-a:latest", modelName: "model-a",
      completedBytes: 1, totalBytes: 10, digests: [DIGEST_A], updatedAt: 100
    });
    store.putLocalRuntimeProviderBinding({
      ...scope(1), providerId: "joko-local-ollama", providerVersion: 2n,
      modelIds: ["model-a"], updatedAt: 101
    });
    store.claimLocalRuntimeInstallation({
      ...scope(1), operationId: "install-old", at: 100, leaseDurationMs: 10_000
    });

    store.activateLocalRuntimeOwner(scope(2));
    expect(store.listLocalModelPullCheckpoints(scope(2))).toEqual([
      expect.objectContaining({ ownerGeneration: 2, modelName: "model-a" })
    ]);
    expect(store.findLocalRuntimeProviderBinding(scope(2))).toMatchObject({ ownerGeneration: 2, providerVersion: 2n });
    expect(store.findLocalRuntimeInstallation(scope(2))).toMatchObject({
      state: "failed",
      publicErrorCode: "OWNER_CHANGED",
      ownerGeneration: 2
    });
    expect(() => store.putLocalModelPullCheckpoint({
      ...scope(1), modelKey: "model-a:latest", modelName: "model-a",
      completedBytes: 9, totalBytes: 10, digests: [DIGEST_A]
    })).toThrow(StaleGenerationError);
    expect(() => store.heartbeatLocalRuntimeInstallation({
      ...scope(1), operationId: "install-old", leaseDurationMs: 2_000
    })).toThrow(StaleGenerationError);
  });

  it("orders checkpoints, suppresses stale progress and removes one exact model", () => {
    const { store } = createFixture();
    store.activateLocalRuntimeOwner(scope(1));
    const first = store.putLocalModelPullCheckpoint({
      ...scope(1), modelKey: "model-a:latest", modelName: "model-a",
      completedBytes: 5, totalBytes: 10, percent: 50,
      digests: [DIGEST_B, DIGEST_A, DIGEST_B], updatedAt: 2_000
    });
    expect(first.digests).toEqual([DIGEST_A, DIGEST_B]);
    const stale = store.putLocalModelPullCheckpoint({
      ...scope(1), modelKey: "model-a:latest", modelName: "model-a",
      completedBytes: 1, totalBytes: 10, percent: 10,
      digests: [DIGEST_A], updatedAt: 1_999
    });
    expect(stale).toMatchObject({ completedBytes: 5, percent: 50, updatedAt: 2_000 });
    store.putLocalModelPullCheckpoint({
      ...scope(1), modelKey: "model-b:latest", modelName: "model-b",
      digests: [], updatedAt: 2_001
    });
    expect(store.listLocalModelPullCheckpoints(scope(1)).map((item) => item.modelName)).toEqual(["model-a", "model-b"]);
    expect(store.removeLocalModelPullCheckpoint(scope(1), "model-a:latest")).toMatchObject({ modelName: "model-a" });
    expect(store.listLocalModelPullCheckpoints(scope(1)).map((item) => item.modelName)).toEqual(["model-b"]);
  });

  it("records terminal install failures as public codes only", () => {
    const fixture = createFixture();
    fixture.store.activateLocalRuntimeOwner(scope(1));
    fixture.store.claimLocalRuntimeInstallation({
      ...scope(1), operationId: "install-1", at: 100, leaseDurationMs: 2_000
    });
    expect(fixture.store.failLocalRuntimeInstallation({
      ...scope(1), operationId: "install-1", state: "cancelled",
      publicErrorCode: "OPERATION_CANCELLED", at: 200
    })).toMatchObject({ state: "cancelled", publicErrorCode: "OPERATION_CANCELLED" });
    expect(() => fixture.store.failLocalRuntimeInstallation({
      ...scope(1), operationId: "install-1", state: "failed",
      publicErrorCode: "contains /private/path"
    })).toThrow(StoreError);
  });

  it("rejects path-like model metadata and never writes rejected sensitive input", () => {
    const fixture = createFixture();
    fixture.store.activateLocalRuntimeOwner(scope(1));
    const sensitivePath = "D:/private/credential-file";
    const sensitiveValue = "sk-local-secret-material";
    expect(() => fixture.store.putLocalModelPullCheckpoint({
      ...scope(1), modelKey: sensitivePath, modelName: sensitivePath,
      digests: [sensitiveValue]
    })).toThrow(StoreError);
    expect(() => fixture.store.putLocalRuntimeProviderBinding({
      ...scope(1), providerId: "joko-local-ollama", providerVersion: 1n,
      modelIds: ["../private-model"]
    })).toThrow(StoreError);

    fixture.close();
    for (const fileName of readdirSync(fixture.directory)) {
      const bytes = readFileSync(join(fixture.directory, fileName));
      expect(bytes.includes(Buffer.from(sensitivePath))).toBe(false);
      expect(bytes.includes(Buffer.from(sensitiveValue))).toBe(false);
    }
  });
});

function scope(ownerGeneration: number) {
  return { ownerId: "owner-a", runtimeId: "ollama", ownerGeneration };
}

function createFixture(): {
  readonly directory: string;
  readonly filePath: string;
  readonly store: OperationalStore;
  close(): void;
  reopen(): OperationalStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "joko-local-runtime-store-"));
  const filePath = join(directory, "operational.sqlite");
  let clock = 50_000;
  const open = () => new OperationalStore(filePath, { now: () => ++clock });
  let store = open();
  let closed = false;
  cleanups.push(() => {
    if (!closed) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    filePath,
    get store() { return store; },
    close() {
      if (!closed) store.close();
      closed = true;
    },
    reopen() {
      if (!closed) store.close();
      store = open();
      closed = false;
      return store;
    }
  };
}
