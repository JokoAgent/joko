import { create } from "@bufbuild/protobuf";
import {
  EntityVersionSchema,
  ManagedModelRuntimeCapabilitiesSchema,
  ManagedModelRuntimeCatalogModelSchema,
  ManagedModelRuntimeErrorCode,
  ManagedModelRuntimeModelSchema,
  ManagedModelRuntimePreflightSchema,
  ManagedModelRuntimeResourceState,
  ManagedModelRuntimeSchema,
  ManagedModelRuntimeSource,
  ManagedModelRuntimeState,
  ManagedModelRuntimeTransferKind,
  ManagedModelRuntimeTransferPhase,
  ManagedModelRuntimeTransferSchema,
  RevisionSchema
} from "@joko/contracts";
import { describe, expect, it } from "vitest";

import { mapManagedModelRuntime } from "./gateway.js";

describe("managed model runtime gateway projection", () => {
  it("preserves capability, preflight, model and transfer authority", () => {
    const runtime = mapManagedModelRuntime(create(ManagedModelRuntimeSchema, {
      runtimeId: "runtime-a",
      displayName: "Local Runtime",
      state: ManagedModelRuntimeState.READY,
      source: ManagedModelRuntimeSource.MANAGED_SIDECAR,
      version: "1.2.3",
      capabilities: create(ManagedModelRuntimeCapabilitiesSchema, {
        canInstall: true,
        canCancelInstall: true,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true,
        canResumePulls: true,
        canCancelPulls: true,
        supportsCustomModels: true,
        supportsCuratedCatalog: true,
        supportsModelPreflight: true
      }),
      installPreflight: create(ManagedModelRuntimePreflightSchema, {
        allowed: true,
        memory: ManagedModelRuntimeResourceState.CONSTRAINED,
        disk: ManagedModelRuntimeResourceState.SUFFICIENT,
        requiredDiskBytes: 1_024n
      }),
      installedModels: [create(ManagedModelRuntimeModelSchema, {
        modelName: "model:a",
        displayName: "Model A",
        sizeBytes: 2_048n,
        contextWindowTokens: 32_768n,
        supportsTools: true,
        supportsImages: true
      })],
      catalog: [create(ManagedModelRuntimeCatalogModelSchema, {
        catalogId: "catalog-a",
        modelName: "catalog:a",
        displayName: "Catalog A",
        sizeBytes: 4_096n,
        minimumMemoryGb: 16,
        recommended: true,
        preflight: create(ManagedModelRuntimePreflightSchema, {
          allowed: false,
          memory: ManagedModelRuntimeResourceState.SUFFICIENT,
          disk: ManagedModelRuntimeResourceState.INSUFFICIENT,
          requiredDiskBytes: 8_192n,
          errorCode: ManagedModelRuntimeErrorCode.DISK_SPACE_LOW
        })
      })],
      transfers: [create(ManagedModelRuntimeTransferSchema, {
        kind: ManagedModelRuntimeTransferKind.MODEL_PULL,
        modelName: "catalog:a",
        phase: ManagedModelRuntimeTransferPhase.DOWNLOADING,
        completedBytes: 50n,
        totalBytes: 100n,
        percent: 50,
        bytesPerSecond: 25n,
        done: false
      })],
      entityVersion: create(EntityVersionSchema, {
        revision: create(RevisionSchema, { value: 9n, etag: "runtime-9" }),
        generation: 7n
      })
    }));

    expect(runtime).toMatchObject({
      id: "runtime-a",
      state: "ready",
      source: "managedSidecar",
      capabilities: { canPullModels: true, supportsCustomModels: true },
      installPreflight: { memory: "constrained", disk: "sufficient" },
      installedModels: [{ name: "model:a", contextWindowTokens: 32_768, supportsTools: true, supportsImages: true }],
      catalog: [{ id: "catalog-a", recommended: true, preflight: { allowed: false, errorCode: "diskSpaceLow" } }],
      transfers: [{ kind: "modelPull", phase: "downloading", percent: 50, bytesPerSecond: 25 }],
      revision: 9n
    });
  });
});
