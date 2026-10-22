import type { AdapterContext, ApprovedSkillSeed } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { PiResourceManager, RuntimeResourceCatalogSource, RuntimeTextResourceSeed } from "./resource-manager.js";

export interface HostedAgentSourceResourceCatalogOptions {
  readonly store: OperationalStore;
  readonly resources: PiResourceManager;
  /** Exact local instances configured by the application, keyed by native Adapter kind. */
  readonly nativeBackends: ReadonlyMap<string, string>;
  readonly allowedSkillIds?: (context: AdapterContext) => ReadonlySet<string> | undefined;
}

/** Native text approval follows the original node's catalog. A model on a
 * paired node supplies neither resource approval nor personal configuration. */
export class HostedAgentSourceResourceCatalog {
  constructor(private readonly options: HostedAgentSourceResourceCatalogOptions) {}

  async text(context: AdapterContext, nativeKind: string): Promise<readonly RuntimeTextResourceSeed[]> {
    return this.options.resources.runtimeTextSnapshot(context.target.backendId, context.target.id, context.signal,
      this.options.allowedSkillIds?.(context), context, this.#source(context, nativeKind));
  }

  async skills(context: AdapterContext, signal: AbortSignal, nativeKind: string): Promise<readonly ApprovedSkillSeed[]> {
    return this.options.resources.runtimeSkillSnapshot(context.target.backendId, context.target.id, signal,
      this.options.allowedSkillIds?.(context), context, this.#source(context, nativeKind));
  }

  #source(context: AdapterContext, nativeKind: string): RuntimeResourceCatalogSource | undefined {
    const backendId = this.options.nativeBackends.get(nativeKind);
    if (backendId === undefined) return undefined;
    const assertCurrent = () => {
      context.signal.throwIfAborted();
      if (this.options.store.getBackend(backendId).descriptor.adapterKind !== nativeKind) {
        throw new Error("The original native resource catalog owner changed.");
      }
    };
    assertCurrent();
    return { backendId, assertCurrent };
  }
}
