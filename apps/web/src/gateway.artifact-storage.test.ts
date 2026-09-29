import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  ArtifactStorageCleanupStatus,
  ArtifactStorageCleanupPhase,
  CapabilitySupport,
  BeginArtifactStorageCleanupResponseSchema,
  GetArtifactStorageCleanupResponseSchema,
  GetArtifactStorageStatsResponseSchema,
  GetSnapshotResponseSchema,
  ReconcileArtifactStorageResponseSchema,
  ScanArtifactStorageResponseSchema,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("Artifact storage gateway", () => {
  it("maps the capability and preserves the draft-content fence through cleanup", async () => {
    const digest = "a".repeat(64);
    const token = "b".repeat(64);
    const calls: Array<{ readonly method: string; readonly input: any }> = [];
    const transport = artifactTransport((method, input) => {
      calls.push({ method: method.localName, input });
      if (method.localName === "getArtifactStorageStats") {
        return create(GetArtifactStorageStatsResponseSchema, {
          support: CapabilitySupport.SUPPORTED,
          stats: { referenceCount: 4n, uniqueBlobCount: 3n, totalBytes: 20n, cacheReferenceCount: 1n, cacheBytes: 5n }
        });
      }
      if (method.localName === "scanArtifactStorage") {
        const expiresAt = Date.now() + 60_000;
        return create(ScanArtifactStorageResponseSchema, {
          scan: {
            token,
            expiresAt: { seconds: BigInt(Math.floor(expiresAt / 1_000)), nanos: (expiresAt % 1_000) * 1_000_000 },
            protectedReferenceCount: 1n,
            expiredReferenceCount: 2n,
            cleanableBytes: 10n
          }
        });
      }
      if (method.localName === "reconcileArtifactStorage") {
        return create(ReconcileArtifactStorageResponseSchema, { result: { healthy: true } });
      }
      if (method.localName === "beginArtifactStorageCleanup" || method.localName === "getArtifactStorageCleanup") {
        const progress = { maintenanceId: token, status: ArtifactStorageCleanupStatus.COMPLETED,
          phase: ArtifactStorageCleanupPhase.RECONCILING, percent: 100,
          updatedAt: { seconds: 1n, nanos: 0 },
          result: { expiredReferencesDeleted: 2n, freedBytes: 10n } };
        return method.localName === "beginArtifactStorageCleanup"
          ? create(BeginArtifactStorageCleanupResponseSchema, { progress })
          : create(GetArtifactStorageCleanupResponseSchema, { progress });
      }
      throw new Error(`Unexpected method ${method.localName}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "connection-storage", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.getArtifactStorageStats([digest])).resolves.toMatchObject({
      support: "supported",
      stats: { referenceCount: 4, uniqueBlobCount: 3, totalBytes: 20 }
    });
    await expect(gateway.scanArtifactStorage([digest])).resolves.toMatchObject({
      token,
      protectedReferenceCount: 1,
      expiredReferenceCount: 2,
      cleanableBytes: 10
    });
    await expect(gateway.reconcileArtifactStorage([digest])).resolves.toEqual({
      healthy: true,
      missingBlobCount: 0,
      orphanBlobCount: 0,
      unsafeEntryCount: 0
    });
    await expect(gateway.beginArtifactStorageCleanup(token, [digest])).resolves.toMatchObject({
      status: "completed", result: { expiredReferencesDeleted: 2, freedBytes: 10 }
    });
    await expect(gateway.getArtifactStorageCleanup(token)).resolves.toMatchObject({ status: "completed" });
    expect(calls.filter((call) => call.method.includes("ArtifactStorage")).every((call) =>
      call.method === "getArtifactStorageCleanup" || call.input.protectedSha256?.[0] === digest
    )).toBe(true);
    gateway.disconnect();
  });

  it("returns typed stale-scan outcomes", async () => {
    const transport = artifactTransport((method) => {
      if (method.localName === "beginArtifactStorageCleanup") {
        return create(BeginArtifactStorageCleanupResponseSchema, { progress: {
          maintenanceId: "c".repeat(64), status: ArtifactStorageCleanupStatus.SCAN_EXPIRED,
          phase: ArtifactStorageCleanupPhase.PREPARING, percent: 0,
          updatedAt: { seconds: 1n, nanos: 0 }
        } });
      }
      throw new Error(`Unexpected method ${method.localName}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "connection-storage", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    await expect(gateway.beginArtifactStorageCleanup("c".repeat(64))).resolves.toMatchObject({ status: "scanExpired" });
    gateway.disconnect();
  });
});

function artifactTransport(resolve: (method: any, input: any) => unknown): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) })
        : resolve(method, input);
      return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
    }),
    stream: vi.fn(async (method: any) => ({
      stream: true,
      service: method.parent,
      method,
      header: new Headers(),
      trailer: new Headers(),
      message: idleStream()
    }))
  } as unknown as Transport;
}

async function* idleStream(): AsyncGenerator<never> {
  await new Promise<void>(() => undefined);
}
