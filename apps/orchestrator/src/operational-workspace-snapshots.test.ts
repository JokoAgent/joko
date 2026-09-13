import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalWorkspaceSnapshotRepository } from "./operational-workspace-snapshots.js";
import type { WorkspaceBaseline, WorkspaceChangeSetRecord } from "./workspace-change-set.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("OperationalWorkspaceSnapshotRepository", () => {
  it("durably preserves path-keyed baselines and atomically consumes previews", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-workspace-repository-"));
    const path = join(directory, "orchestrator.db");
    let store = new OperationalStore(path, { now: () => 1_000 });
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    let repository = new OperationalWorkspaceSnapshotRepository(store);
    const baseline: WorkspaceBaseline = {
      id: "baseline-one",
      workspaceId: "workspace-one",
      workspaceRoot: directory,
      files: {
        credentials: {
          path: "credentials",
          sha256: "abc",
          byteLength: 3,
          modifiedAt: 1_000,
          blobPath: join(directory, "blobs", "abc")
        }
      },
      complete: true,
      gaps: [],
      capturedAt: 1_000
    };
    const changeSet: WorkspaceChangeSetRecord = {
      id: "change-one",
      baselineId: baseline.id,
      workspaceId: baseline.workspaceId,
      workspaceRoot: directory,
      sessionId: "session-one",
      runId: "run-one",
      changes: [],
      complete: true,
      gaps: [],
      capturedAt: 1_001
    };
    await repository.putBaseline(baseline);
    await repository.putChangeSet(changeSet);
    await repository.putRewindPreview({
      id: "preview-one",
      changeSetId: changeSet.id,
      conflicts: [],
      gaps: [],
      safe: true,
      expiresAt: 2_000
    });
    store.close();

    store = new OperationalStore(path, { now: () => 1_100 });
    cleanups.push(() => store.close());
    repository = new OperationalWorkspaceSnapshotRepository(store);
    await expect(repository.getBaseline(baseline.id)).resolves.toEqual(baseline);
    await expect(repository.listChangeSets()).resolves.toEqual([changeSet]);
    await expect(repository.consumeRewindPreview("preview-one", 1_100)).resolves.toBe(true);
    await expect(repository.consumeRewindPreview("preview-one", 1_100)).resolves.toBe(false);
  });
});
