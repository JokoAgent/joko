import { mkdir, statfs } from "node:fs/promises";
import { join } from "node:path";

import {
  LocalModelRuntimeManager,
  LlamaCppRuntimeManager,
  OllamaLoopbackClient,
  OllamaRuntimeLauncher,
  type RuntimeAuditEvent,
  type RuntimeOwnerGeneration
} from "@joko/local-model-runtime";
import type { AdapterContext } from "@joko/core";
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
import { ManagedModelRuntimeRegistry } from "./managed-model-runtime-registry.js";
import { ManagedGgufRuntimeController } from "./managed-gguf-runtime-controller.js";
import { ManagedGgufProviderCoordinator } from "./managed-gguf-provider-coordinator.js";
import { MANAGED_GGUF_PROVIDER_ID } from "./managed-gguf-provider.js";

export interface ManagedModelRuntimeSystem {
  readonly registry: ManagedModelRuntimeRegistry;
  prepareProviderRuntime(context: AdapterContext): Promise<void>;
  removeProvider(providerId: string): Promise<boolean | undefined>;
  close(): Promise<void>;
}

export interface ManagedModelRuntimeSystemOptions {
  readonly store: OperationalStore;
  readonly providers: ProviderCatalogManager;
  readonly dataDirectory: string;
  readonly ownerId: string;
  readonly ownerGeneration: number;
  readonly onModelsChanged?: () => Promise<void>;
  readonly onProviderChanged?: (backendIds: readonly string[]) => Promise<void>;
  readonly fetchStreaming: typeof fetch;
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
    backendId: options.providers.nativeAuthenticationBackendId,
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
    providerRoutes: () => providerCoordinator.routes(owner),
    freeDiskBytes: async () => {
      const disk = await statfs(dataRoot, { bigint: true });
      const available = disk.bavail * disk.bsize;
      return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
    }
  });
  const ggufManager: LlamaCppRuntimeManager = new LlamaCppRuntimeManager({
    dataRoot: join(dataRoot, "llama-cpp"), currentOwner: () => activeOwner, fetchStreaming: options.fetchStreaming, healthFetch: fetch,
    validateConnection: async runtimeOwner => ggufProviders.assertConnection(runtimeOwner),
    contextLimits: model => ggufProviders.contextLimits(model),
    onModelsChanged: async (runtimeOwner, models) => {
      const state = await ggufManager.snapshot(runtimeOwner);
      await ggufProviders.sync(runtimeOwner, models, state.catalog);
    }
  });
  const ggufProviders: ManagedGgufProviderCoordinator = new ManagedGgufProviderCoordinator({
    providers: options.providers, currentOwner: () => activeOwner,
    backendIds: () => options.store.listBackends().filter(backend => backend.descriptor.capabilities.get("provider.managed_catalog")?.supported === true)
      .map(backend => backend.descriptor.id),
    snapshot: runtimeOwner => ggufManager.snapshot(runtimeOwner),
    configure: (runtimeOwner, effect) => ggufManager.configure(runtimeOwner, effect),
    remove: (runtimeOwner, effect) => ggufManager.remove(runtimeOwner, effect),
    onChanged: options.onProviderChanged
  });
  const ggufController = new ManagedGgufRuntimeController({
    owner, currentOwner: () => activeOwner,
    manager: {
      snapshot: async runtimeOwner => {
        const state = await ggufManager.snapshot(runtimeOwner);
        await ggufProviders.sync(runtimeOwner, state.models, state.catalog);
        return state;
      },
      listRepositoryFiles: (runtimeOwner, repository, signal) => ggufManager.listRepositoryFiles(runtimeOwner, repository, signal),
      install: runtimeOwner => ggufManager.install(runtimeOwner),
      download: (runtimeOwner, selection) => ggufManager.download(runtimeOwner, selection),
      pause: (runtimeOwner, target) => ggufManager.pause(runtimeOwner, target),
      resume: (runtimeOwner, target) => ggufManager.resume(runtimeOwner, target),
      cancel: (runtimeOwner, target) => ggufManager.cancel(runtimeOwner, target),
      start: async (runtimeOwner, startOptions) => {
        await ggufManager.start(runtimeOwner, startOptions); ggufProviders.didStart();
      },
      stop: async runtimeOwner => { await ggufManager.stop(runtimeOwner); ggufProviders.didStop(); },
      dispose: async runtimeOwner => { await ggufManager.dispose(runtimeOwner); ggufProviders.didStop(); }
    },
    providerRoutes: () => ggufProviders.routes(),
    ensureProvider: signal => ggufProviders.ensure(owner, signal),
    getModelContext: (targets, signal) => ggufProviders.getContext(owner, targets, signal),
    setModelContext: (targets, limit, signal) => ggufProviders.setContext(owner, targets, limit, signal)
  });
  const registry = new ManagedModelRuntimeRegistry([controller, ggufController]);
  let closed = false;
  return {
    registry,
    async prepareProviderRuntime(context) {
      if (context.target.remoteWorkspace !== undefined || context.modelSelection?.providerId !== MANAGED_GGUF_PROVIDER_ID) return;
      ggufProviders.assertConnection(owner); context.signal.throwIfAborted();
      const route = ggufProviders.routes().find(item => item.backendId === context.target.backendId && item.providerId === context.modelSelection!.providerId);
      const state = await ggufManager.snapshot(owner); context.signal.throwIfAborted();
      if (!route || !state.models.some(model => model.id === context.modelSelection!.modelId)) throw new Error("The selected managed local model is unavailable.");
      await ggufManager.start(owner, { signal: context.signal });
      ggufProviders.didStart(); context.signal.throwIfAborted(); ggufProviders.assertConnection(owner);
    },
    removeProvider: providerId => ggufProviders.removeProvider(owner, providerId),
    async close() {
      if (closed) return;
      await registry.close();
      launcher.stopManaged();
      activeOwner = undefined;
      closed = true;
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
