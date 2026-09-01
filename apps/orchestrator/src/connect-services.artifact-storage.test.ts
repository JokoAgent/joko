import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ArtifactStorageCleanupOutcome,
  CapabilitySupport,
  CleanupArtifactStorageRequestSchema,
  GetArtifactStorageStatsRequestSchema,
  ScanArtifactStorageRequestSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { ArtifactMaintenanceScanExpiredError } from "./artifact-maintenance.js";
import { createConnectServices } from "./connect-services.js";

describe("Artifact storage Connect service", () => {
  it("projects path-free reports and keeps the protected digest on destructive confirmation", async () => {
    const cleanup = vi.fn(async () => ({
      expiredReferencesDeleted: 2,
      blobsRemoved: 1,
      temporaryFilesRemoved: 0,
      freedBytes: 12,
      skipped: 0
    }));
    const maintenance = {
      stats: vi.fn(async () => ({
        referenceCount: 3,
        uniqueBlobCount: 2,
        totalBytes: 20,
        cacheReferenceCount: 1,
        cacheBytes: 8,
        temporaryFileCount: 0,
        temporaryBytes: 0
      })),
      scan: vi.fn(async () => ({
        token: "a".repeat(64),
        expiresAt: 60_000,
        protectedReferenceCount: 1,
        expiredReferenceCount: 2,
        orphanBlobCount: 1,
        orphanBlobBytes: 12,
        temporaryFileCount: 0,
        temporaryBytes: 0,
        missingBlobCount: 0,
        unsafeEntryCount: 0,
        cleanableBytes: 12
      })),
      reconcile: vi.fn(async () => ({ healthy: true, missingBlobCount: 0, orphanBlobCount: 0, unsafeEntryCount: 0 })),
      cleanup
    };
    const services = createConnectServices(application(maintenance));
    const digest = "b".repeat(64);
    const handlerContext = context();

    const stats = await services.artifact.getArtifactStorageStats(create(GetArtifactStorageStatsRequestSchema, { protectedSha256: [digest] }), handlerContext);
    expect(stats).toMatchObject({ support: CapabilitySupport.SUPPORTED, stats: { totalBytes: 20n } });
    expect(maintenance.stats).toHaveBeenCalledWith([digest]);
    const scan = await services.artifact.scanArtifactStorage(create(ScanArtifactStorageRequestSchema, { protectedSha256: [digest] }), handlerContext);
    expect(scan.scan).toMatchObject({ token: "a".repeat(64), protectedReferenceCount: 1n, cleanableBytes: 12n });
    const result = await services.artifact.cleanupArtifactStorage(create(CleanupArtifactStorageRequestSchema, { scanToken: "a".repeat(64), protectedSha256: [digest] }), handlerContext);
    expect(result).toMatchObject({ outcome: ArtifactStorageCleanupOutcome.COMPLETED, result: { freedBytes: 12n } });
    expect(cleanup).toHaveBeenCalledWith("a".repeat(64), [digest]);
    expect(JSON.stringify({ stats, scan, result }, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toMatch(/[A-Z]:\\|\/var\/|storagePath/iu);
  });

  it("returns a typed expired-scan outcome", async () => {
    const maintenance = {
      stats: vi.fn(),
      scan: vi.fn(),
      reconcile: vi.fn(),
      cleanup: vi.fn(async () => { throw new ArtifactMaintenanceScanExpiredError(); })
    };
    const services = createConnectServices(application(maintenance));
    await expect(services.artifact.cleanupArtifactStorage(create(CleanupArtifactStorageRequestSchema, { scanToken: "c".repeat(64), protectedSha256: [] }), context()))
      .resolves.toEqual({ outcome: ArtifactStorageCleanupOutcome.SCAN_EXPIRED });
  });

  it("redacts service paths from maintenance failures", async () => {
    const maintenance = {
      stats: vi.fn(),
      scan: vi.fn(async () => { throw new Error("EACCES D:\\private\\artifact-store"); }),
      reconcile: vi.fn(),
      cleanup: vi.fn()
    };
    const services = createConnectServices(application(maintenance));
    const failure = await Promise.resolve(services.artifact.scanArtifactStorage(
      create(ScanArtifactStorageRequestSchema, {}),
      context()
    )).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectError);
    expect(failure).toMatchObject({ code: Code.Internal, rawMessage: "Artifact storage scan failed." });
    expect(String(failure)).not.toContain("private");
  });
});

function application(artifactMaintenance: unknown): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: {
      authenticate: () => ({
        id: "connection-storage",
        deviceId: "device-storage",
        name: "Storage test",
        authKeyDigest: "digest",
        state: "active",
        pairedAt: 1,
        revision: 1n
      })
    },
    artifacts: {},
    artifactMaintenance,
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: {},
    sessionWorktrees: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

function context(): any {
  return { requestHeader: new Headers(), signal: new AbortController().signal };
}
