import { mkdir, statfs } from "node:fs/promises";
import { join } from "node:path";

import {
  LocalModelRuntimeManager,
  OllamaLoopbackClient,
  OllamaRuntimeLauncher,
  type RuntimeAuditEvent,
  type RuntimeOwnerGeneration
} from "@joko/local-model-runtime";
import type { OperationalStore } from "@joko/store";

import type { ProviderCatalogManager } from "./credential-manager.js";
import {
  LocalModelProviderCoordinator
} from "./local-model-runtime-coordinator.js";
import {
  activateLocalModelRuntimePersistence,
  StoreLocalModelProviderBindings,
  StorePausedPullRepository,
  StoreRuntimeInstallLeaseRepository
} from "./local-model-runtime-persistence.js";
import { ManagedModelRuntimeController } from "./managed-model-runtime-controller.js";

export interface ManagedModelRuntimeSystem {
  readonly controller: ManagedModelRuntimeController;
  close(): Promise<void>;
}

export interface ManagedModelRuntimeSystemOptions {
  readonly store: OperationalStore;
  readonly providers: ProviderCatalogManager;
  readonly dataDirectory: string;
  readonly ownerId: string;
  readonly ownerGeneration: number;
  readonly onModelsChanged?: () => Promise<void>;
}

/** Compose the node-owned runtime without any Desktop or renderer IPC. */
export async function createManagedModelRuntimeSystem(
  options: ManagedModelRuntimeSystemOptions
): Promise<ManagedModelRuntimeSystem> {
  const dataRoot = join(options.dataDirectory, "managed-model-runtime");
  await mkdir(dataRoot, { recursive: true });
  const owner: RuntimeOwnerGeneration = {
    ownerId: options.ownerId,
    generation: options.ownerGeneration
  };
  let activeOwner: RuntimeOwnerGeneration | undefined = owner;
  activateLocalModelRuntimePersistence(options.store, owner);
  const client = new OllamaLoopbackClient();
  const launcher = new OllamaRuntimeLauncher({ client, dataRoot });
  const providerCoordinator = new LocalModelProviderCoordinator({
    providers: options.providers,
    currentOwner: () => activeOwner,
    bindings: new StoreLocalModelProviderBindings(options.store)
  });
  let synchronizedModels = "";
  const manager = new LocalModelRuntimeManager({
    client,
    launcher,
    dataRoot,
    currentOwner: () => activeOwner,
    pausedPulls: new StorePausedPullRepository(options.store),
    installLeases: new StoreRuntimeInstallLeaseRepository(options.store),
    onModelsChanged: async (runtimeOwner, models) => {
      const fingerprint = JSON.stringify(models);
      if (fingerprint === synchronizedModels) return;
      await providerCoordinator.sync(runtimeOwner, models);
      await options.onModelsChanged?.();
      synchronizedModels = fingerprint;
    },
    audit: (event) => appendRuntimeAudit(options.store, event)
  });
  const controller = new ManagedModelRuntimeController({
    manager,
    owner,
    freeDiskBytes: async () => {
      const disk = await statfs(dataRoot, { bigint: true });
      const available = disk.bavail * disk.bsize;
      return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
    }
  });
  let closed = false;
  return {
    controller,
    async close() {
      if (closed) return;
      closed = true;
      await controller.close();
      launcher.stopManaged();
      activeOwner = undefined;
    }
  };
}

function appendRuntimeAudit(store: OperationalStore, event: RuntimeAuditEvent): void {
  store.appendDiagnostic({
    severity: event.outcome === "failed" ? "warning" : "info",
    component: "managed-model-runtime",
    code: `${event.code.toUpperCase()}_${event.outcome.toUpperCase()}`,
    message: runtimeAuditMessage(event),
    details: {
      ownerGeneration: event.ownerGeneration,
      ...(event.modelName === undefined ? {} : { modelName: event.modelName }),
      ...(event.publicErrorCode === undefined ? {} : { publicErrorCode: event.publicErrorCode })
    }
  });
}

function runtimeAuditMessage(event: RuntimeAuditEvent): string {
  const subject = event.code === "runtime_probe" ? "Runtime probe"
    : event.code === "runtime_install" ? "Runtime installation"
      : event.code === "runtime_start" ? "Runtime start"
        : event.code === "model_pull" ? "Model pull"
          : event.code === "model_delete" ? "Model deletion"
            : "Model synchronization";
  return `${subject} ${event.outcome}.`;
}
