import type { OperationalStore } from "@joko/store";
import type { ProviderCatalogManager } from "./credential-manager.js";
import { isOwnedGgufProvider } from "./managed-gguf-provider.js";
import { ModelWorkingContextCoordinator, type ModelWorkingContextRoute } from "./model-working-context.js";
import type { SessionHost } from "./session-host.js";

export interface ModelWorkingContextSystemOptions {
  readonly store: OperationalStore;
  readonly providers: Pick<ProviderCatalogManager, "listConfigurations">;
  readonly currentOwner: () => { readonly ownerId: string; readonly generation: number } | undefined;
  readonly sessionHost: Pick<SessionHost, "refreshModelWorkingContexts">;
}

/** Bind working budgets to the current node catalog without changing its capacities. */
export function composeModelWorkingContext(options: ModelWorkingContextSystemOptions): ModelWorkingContextCoordinator {
  return new ModelWorkingContextCoordinator({
    store: options.store,
    currentOwner: options.currentOwner,
    resolveRoute: target => {
      const configuration = options.providers.listConfigurations().find(item => item.providerId === target.providerId);
      if (configuration?.runtimes.some(runtime => isOwnedGgufProvider(runtime))) return undefined;
      const backend = options.store.listBackends().find(item => item.descriptor.id === target.backendId);
      if (!backend) return undefined;
      const model = backend.descriptor.models.find(item => item.providerId === target.providerId && item.modelId === target.modelId);
      if (!model) return undefined;
      const route: ModelWorkingContextRoute = {
        model,
        catalogRevision: backend.revision,
        instanceGeneration: backend.descriptor.instanceGeneration,
        ...(configuration === undefined ? {} : { providerRevision: configuration.version }),
        supported: backend.descriptor.capabilities.get("model.working_context")?.supported === true,
        available: true
      };
      return route;
    },
    refresh: (targets, assertCurrent, signal) => options.sessionHost.refreshModelWorkingContexts(targets, assertCurrent, signal)
  });
}
