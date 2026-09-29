import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ArtifactStorageCleanupStatus,
  CapabilitySupport,
  BeginArtifactStorageCleanupRequestSchema,
  GetArtifactStorageCleanupRequestSchema,
  GetArtifactStorageStatsRequestSchema,
  ScanArtifactStorageRequestSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { ArtifactMaintenanceScanExpiredError } from "./artifact-maintenance.js";
import { createConnectServices } from "./connect-services.js";

describe("Artifact storage Connect service", () => {
  it("projects path-free reports and keeps the protected digest on destructive confirmation", async () => {
    const cleanup = vi.fn(async () => ({ maintenanceId: "a".repeat(64), status: "completed", phase: "reconciling",
      percent: 100, updatedAt: 1_000, result: {
        expiredReferencesDeleted: 2, blobsRemoved: 1, temporaryFilesRemoved: 0, freedBytes: 12, skipped: 0
      } }));
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
      beginCleanup: cleanup,
      getCleanup: vi.fn(() => ({ maintenanceId: "a".repeat(64), status: "completed", phase: "reconciling",
        percent: 100, updatedAt: 1_000, result: {
          expiredReferencesDeleted: 2, blobsRemoved: 1, temporaryFilesRemoved: 0, freedBytes: 12, skipped: 0
        } }))
    };
    const services = createConnectServices(application(maintenance));
    const digest = "b".repeat(64);
    const handlerContext = context();

    const stats = await services.artifact.getArtifactStorageStats(create(GetArtifactStorageStatsRequestSchema, { protectedSha256: [digest] }), handlerContext);
    expect(stats).toMatchObject({ support: CapabilitySupport.SUPPORTED, stats: { totalBytes: 20n } });
    expect(maintenance.stats).toHaveBeenCalledWith([digest]);
    const scan = await services.artifact.scanArtifactStorage(create(ScanArtifactStorageRequestSchema, { protectedSha256: [digest] }), handlerContext);
    expect(scan.scan).toMatchObject({ token: "a".repeat(64), protectedReferenceCount: 1n, cleanableBytes: 12n });
    const result = await services.artifact.beginArtifactStorageCleanup(create(BeginArtifactStorageCleanupRequestSchema, { scanToken: "a".repeat(64), protectedSha256: [digest] }), handlerContext);
    expect(result).toMatchObject({ progress: { status: ArtifactStorageCleanupStatus.COMPLETED, result: { freedBytes: 12n } } });
    expect(services.artifact.getArtifactStorageCleanup(create(GetArtifactStorageCleanupRequestSchema, { maintenanceId: "a".repeat(64) }), handlerContext))
      .toMatchObject({ progress: { maintenanceId: "a".repeat(64), status: ArtifactStorageCleanupStatus.COMPLETED } });
    expect(cleanup).toHaveBeenCalledWith("a".repeat(64), [digest]);
    expect(JSON.stringify({ stats, scan, result }, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toMatch(/[A-Z]:\\|\/var\/|storagePath/iu);
  });

  it("returns a typed expired-scan outcome", async () => {
    const maintenance = {
      stats: vi.fn(),
      scan: vi.fn(),
      reconcile: vi.fn(),
      beginCleanup: vi.fn(async () => { throw new ArtifactMaintenanceScanExpiredError(); })
    };
    const services = createConnectServices(application(maintenance));
    await expect(services.artifact.beginArtifactStorageCleanup(create(BeginArtifactStorageCleanupRequestSchema, { scanToken: "c".repeat(64), protectedSha256: [] }), context()))
      .resolves.toMatchObject({ progress: { status: ArtifactStorageCleanupStatus.SCAN_EXPIRED } });
  });

  it("redacts service paths from maintenance failures", async () => {
    const maintenance = {
      stats: vi.fn(),
      scan: vi.fn(async () => { throw new Error("EACCES D:\\private\\artifact-store"); }),
      reconcile: vi.fn(),
      beginCleanup: vi.fn()
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
