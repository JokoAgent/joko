import { create } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { ManagedModelRuntimeController } from "./managed-model-runtime-controller.js";
import type { ManagedModelRuntimeManagerPort } from "./managed-model-runtime-controller.js";
import {
  createManagedModelRuntimeConnectService,
  mapManagedModelRuntime
} from "./managed-model-runtime-connect-service.js";

const owner = { ownerId: "orchestrator-a", generation: 1 } as const;

function controller(): ManagedModelRuntimeController {
  const manager: ManagedModelRuntimeManagerPort = {
    status: async () => ({
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
    }),
    curated: () => ({
      catalog: [{
        id: "catalog-a",
        displayName: "Catalog A",
        libraryName: "catalog:a",
        aliases: ["catalog"],
        sizeBytes: 4_096,
        minimumMemoryGb: 8,
        appleSiliconOnly: false
      }],
      recommended: []
    }),
    runtimePreflight: () => ({ allowed: true, memory: "sufficient", disk: "unknown", requiredDiskBytes: 2_048 }),
    modelPreflight: () => ({ allowed: true, memory: "sufficient", disk: "unknown", requiredDiskBytes: 8_192 }),
    installProgress: () => undefined,
    list: async () => [{
      name: "model:a",
      sizeBytes: 128,
      contextLength: 16_384,
      capabilities: ["tools", "vision"]
    }],
    paused: async () => [],
    activePulls: () => [],
    start: async () => ({
      runtime: "ollama",
      state: "ready",
      source: "running",
      capabilities: {
        canInstall: true,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true
      }
    }),
    install: async () => ({
      runtime: "ollama",
      state: "ready",
      source: "managed_sidecar",
      capabilities: {
        canInstall: false,
        canStart: true,
        canListModels: true,
        canPullModels: true,
        canDeleteModels: true,
        canPausePulls: true
      }
    }),
    abortInstall: () => undefined,
    pull: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    delete: async () => undefined,
    shutdown: async () => undefined
  };
  return new ManagedModelRuntimeController({ manager, owner, now: () => 123 });
}

describe("managed model runtime Connect service", () => {
  it("maps capability, recommendation, model metadata and preflight without endpoint or path data", async () => {
    const runtimeController = controller();
    const snapshot = await runtimeController.snapshot();
    const projected = mapManagedModelRuntime(snapshot);
    expect(projected).toMatchObject({
      runtimeId: "ollama",
      state: contract.ManagedModelRuntimeState.READY,
      capabilities: {
        canPullModels: true,
        supportsCustomModels: true,
        supportsCuratedCatalog: true
      },
      installedModels: [{
        modelName: "model:a",
        contextWindowTokens: 16_384n,
        supportsTools: true,
        supportsImages: true
      }],
      catalog: [{ catalogId: "catalog-a", modelName: "catalog:a", preflight: { allowed: true } }]
    });
    expect(JSON.stringify(projected, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toMatch(/[A-Z]:\\|\/Users\/|credential|api.?key/iu);
  });

  it("authenticates reads and rejects unknown runtime identities", async () => {
    const authenticate = vi.fn();
    const service = createManagedModelRuntimeConnectService(controller(), authenticate);
    const context = {} as HandlerContext;
    const listed = await service.listManagedModelRuntimes(
      create(contract.ListManagedModelRuntimesRequestSchema),
      context
    );
    expect(listed.runtimes).toHaveLength(1);
    expect(authenticate).toHaveBeenCalledWith(context);
    await expect(service.getManagedModelRuntime(
      create(contract.GetManagedModelRuntimeRequestSchema, { runtimeId: "missing" }),
      context
    )).rejects.toMatchObject({ code: 5 });
  });

  it("returns an empty capability-discovery list when the node has no runtime", async () => {
    const service = createManagedModelRuntimeConnectService(undefined, () => undefined);
    await expect(service.listManagedModelRuntimes(
      create(contract.ListManagedModelRuntimesRequestSchema),
      {} as HandlerContext
    )).resolves.toMatchObject({ runtimes: [] });
  });
});
