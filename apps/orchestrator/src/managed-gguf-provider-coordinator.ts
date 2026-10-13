import type { PiManagedModel, PiManagedProvider } from "@joko/adapter-pi";
import { LLAMA_CPP_OPENAI_BASE_URL, LocalRuntimeError, assertActiveOwner, assertLlamaCppSelection,
  llamaCppContextSize, llamaCppMaximumContext, llamaCppModelId, sameLlamaCppSelection,
  type LlamaCppCatalogEntry, type LlamaCppModel, type LlamaCppSnapshot, type RuntimeOwnerGeneration } from "@joko/local-model-runtime";
import type { ProviderCatalogManager, ProviderConfigurationDescriptor, ProviderDescriptor, ManagedProviderRuntimeInput } from "./credential-manager.js";
import type { ManagedRuntimeModelContext, ManagedRuntimeModelTarget, ManagedRuntimeProviderRoute } from "./managed-model-runtime-port.js";
import { MANAGED_GGUF_PROVIDER_ID, MANAGED_GGUF_MARKER, isOwnedGgufProvider } from "./managed-gguf-provider.js";
export interface ManagedGgufProviderCoordinatorOptions {
  readonly providers: Pick<ProviderCatalogManager, "listConfigurations" | "upsertConfiguration" | "delete">;
  readonly currentOwner: () => RuntimeOwnerGeneration | undefined;
  readonly backendIds: () => readonly string[];
  readonly snapshot: (owner: RuntimeOwnerGeneration) => Promise<LlamaCppSnapshot>;
  readonly configure: <T>(owner: RuntimeOwnerGeneration, effect: () => Promise<T>) => Promise<T>;
  readonly remove: <T>(owner: RuntimeOwnerGeneration, effect: () => Promise<T>) => Promise<T>;
  readonly onChanged?: (backendIds: readonly string[]) => Promise<void>;
}

/** The Provider catalog is the sole durable authority for each route's context budget. */
export class ManagedGgufProviderCoordinator {
  readonly #options: ManagedGgufProviderCoordinatorOptions;
  #presetWindows = new Map<string, number>();
  #appliedWindows = new Map<string, number>();
  constructor(options: ManagedGgufProviderCoordinatorOptions) { this.#options = options; }
  routes(): readonly ManagedRuntimeProviderRoute[] {
    const configuration = this.#configuration();
    return configuration?.runtimes.map(runtime => ({ backendId: runtime.backendId, providerId: MANAGED_GGUF_PROVIDER_ID })) ?? [];
  }
  assertConnection(owner: RuntimeOwnerGeneration): void {
    this.#assert(owner); if (!this.#configuration()) throw unavailable();
  }
  async ensure(owner: RuntimeOwnerGeneration, signal?: AbortSignal): Promise<void> {
    this.#assert(owner, signal);
    if (this.#configuration()) return;
    const backendIds = [...new Set(this.#options.backendIds())];
    if (!backendIds.length) throw unavailable();
    await this.#options.providers.upsertConfiguration({ providerId: MANAGED_GGUF_PROVIDER_ID, displayName: "llama.cpp",
      kind: "local_keyless", enabled: true, expectedVersion: 0n,
      runtimes: backendIds.map(backendId => ({ backendId, provider: providerFor([], undefined, []), credentialBindings: {}, credentialOrigin: "" }))
    }, { stillActive: () => this.#active(owner, signal) });
    this.#assert(owner, signal); await this.#options.onChanged?.(backendIds); this.#assert(owner, signal);
  }
  async sync(owner: RuntimeOwnerGeneration, models: readonly LlamaCppModel[], catalog: readonly LlamaCppCatalogEntry[]): Promise<void> {
    this.#assert(owner); validateModels(models);
    const current = this.#configuration(); if (!current) return;
    const runtimes = current.runtimes.map(runtime => runtimeInput(runtime, providerFor(models, runtime.provider, catalog)));
    if (runtimes.every((runtime, index) => JSON.stringify(runtime.provider) === JSON.stringify(current.runtimes[index]!.provider))) return;
    try {
      await this.#write(owner, current, runtimes);
    } catch (error) {
      this.#assert(owner);
      const latest = this.#configuration();
      if (!latest) return;
      if (latest.runtimes.every(runtime => JSON.stringify(providerFor(models, runtime.provider, catalog)) === JSON.stringify(runtime.provider))) return;
      throw error;
    }
  }
  contextLimits(model: LlamaCppModel): readonly number[] {
    const current = this.#configuration(); if (!current) throw unavailable();
    const limits = current.runtimes.flatMap(runtime => runtime.provider.models.filter(item => item.id === model.id)
      .map(item => item.contextWindow ?? llamaCppContextSize(model)));
    this.#presetWindows.set(model.id, Math.max(llamaCppContextSize(model), ...limits));
    return limits;
  }
  didStart(): void { if (this.#presetWindows.size) this.#appliedWindows = new Map(this.#presetWindows); this.#presetWindows.clear(); }
  didStop(): void { this.#appliedWindows.clear(); this.#presetWindows.clear(); }
  async getContext(owner: RuntimeOwnerGeneration, targets: readonly ManagedRuntimeModelTarget[], signal?: AbortSignal): Promise<ManagedRuntimeModelContext> {
    this.#assert(owner, signal); const state = await this.#options.snapshot(owner); this.#assert(owner, signal);
    return this.#context(owner, targets, state, signal);
  }
  async setContext(owner: RuntimeOwnerGeneration, targets: readonly ManagedRuntimeModelTarget[], limit: number | undefined, signal?: AbortSignal): Promise<ManagedRuntimeModelContext> {
    return this.#options.configure(owner, async () => {
      this.#assert(owner, signal); const state = await this.#options.snapshot(owner); this.#assert(owner, signal);
      const before = this.#context(owner, targets, state, signal);
      if (!before.canConfigure || limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1000 || limit > before.maximumContextWindowTokens)) throw invalid();
      const current = this.#configuration()!;
      const selected = new Set(targets.map(target => target.backendId));
      const runtimes = current.runtimes.map(runtime => runtimeInput(runtime, selected.has(runtime.backendId)
        ? { ...runtime.provider, models: runtime.provider.models.map(model => model.id === targets[0]!.modelId
          ? { ...model, contextWindow: limit ?? before.defaultContextWindowTokens } : model) } : runtime.provider));
      if (runtimes.some((runtime, index) => JSON.stringify(runtime.provider) !== JSON.stringify(current.runtimes[index]!.provider))) await this.#write(owner, current, runtimes, signal);
      this.#assert(owner, signal); return this.#context(owner, targets, state, signal);
    });
  }
  async removeProvider(owner: RuntimeOwnerGeneration, providerId: string): Promise<boolean | undefined> {
    if (providerId !== MANAGED_GGUF_PROVIDER_ID) return undefined;
    this.#assert(owner); const captured = this.#configuration(); if (!captured) return false;
    return this.#options.remove(owner, async () => {
      this.#assert(owner); const current = this.#configuration();
      if (!current || current.version !== captured.version) throw unavailable();
      const removed = await this.#options.providers.delete(providerId, { expectedVersion: captured.version, stillActive: () => this.#active(owner) });
      this.#assert(owner); this.didStop(); return removed;
    });
  }
  #context(owner: RuntimeOwnerGeneration, targets: readonly ManagedRuntimeModelTarget[], state: LlamaCppSnapshot, signal?: AbortSignal): ManagedRuntimeModelContext {
    this.#assert(owner, signal);
    const current = this.#configuration(); const primary = targets[0];
    if (!current || !primary?.repositoryModel || !targets.length || targets.length > 3) throw invalid();
    const model = state.models.find(item => item.id === primary.modelId && sameLlamaCppSelection(item, primary.repositoryModel));
    if (!model) throw invalid();
    const identities = new Set<string>(); const budgets: number[] = [];
    for (const target of targets) {
      if (target.providerId !== MANAGED_GGUF_PROVIDER_ID || target.modelId !== model.id || !sameLlamaCppSelection(target.repositoryModel, model)
        || identities.has(target.backendId)) throw invalid();
      const runtime = current.runtimes.find(item => item.backendId === target.backendId);
      const declared = runtime?.provider.models.find(item => item.id === model.id); if (!declared) throw invalid();
      identities.add(target.backendId); budgets.push(declared.contextWindow ?? llamaCppContextSize(model));
    }
    const allBudgets = current.runtimes.flatMap(runtime => runtime.provider.models.filter(item => item.id === model.id)
      .map(item => item.contextWindow ?? llamaCppContextSize(model)));
    const defaultBudget = llamaCppContextSize(model), maximum = llamaCppMaximumContext(model);
    if (allBudgets.some(value => !Number.isSafeInteger(value) || value < 1000 || value > maximum)) throw invalid();
    return { target: primary, defaultContextWindowTokens: defaultBudget, effectiveContextWindowTokens: budgets[0]!,
      maximumContextWindowTokens: maximum, presets: maximum > defaultBudget ? [defaultBudget, maximum] : [],
      customized: budgets.some(value => value !== defaultBudget), mixed: budgets.some(value => value !== budgets[0]),
      canConfigure: state.canConfigure, pendingApply: state.running && state.canManageRuntime
        && this.#appliedWindows.get(model.id) !== Math.max(defaultBudget, ...allBudgets) };
  }
  #configuration(): ProviderConfigurationDescriptor | undefined {
    const configuration = this.#options.providers.listConfigurations().find(item => item.providerId === MANAGED_GGUF_PROVIDER_ID);
    if (configuration && (!configuration.runtimes.length || configuration.runtimes.some(runtime => !isOwnedGgufProvider(runtime)))) throw unavailable();
    return configuration;
  }
  async #write(owner: RuntimeOwnerGeneration, current: ProviderConfigurationDescriptor, runtimes: readonly ManagedProviderRuntimeInput[], signal?: AbortSignal): Promise<void> {
    this.#assert(owner, signal);
    await this.#options.providers.upsertConfiguration({ providerId: current.providerId, displayName: current.displayName,
      kind: current.kind, enabled: current.enabled, expectedVersion: current.version, runtimes }, { stillActive: () => this.#active(owner, signal) });
    this.#assert(owner, signal); await this.#options.onChanged?.(runtimes.map(runtime => runtime.backendId)); this.#assert(owner, signal);
  }
  #assert(owner: RuntimeOwnerGeneration, signal?: AbortSignal): void { assertActiveOwner(owner, this.#options.currentOwner); signal?.throwIfAborted(); }
  #active(owner: RuntimeOwnerGeneration, signal?: AbortSignal): boolean { const current = this.#options.currentOwner(); return !signal?.aborted && current?.ownerId === owner.ownerId && current.generation === owner.generation; }
}
function runtimeInput(runtime: ProviderDescriptor, provider: PiManagedProvider): ManagedProviderRuntimeInput {
  return { backendId: runtime.backendId, provider, credentialBindings: {}, credentialOrigin: "",
    ...(runtime.requestPath === undefined ? {} : { requestPath: runtime.requestPath }),
    ...(runtime.modelsEndpoint === undefined ? {} : { modelsEndpoint: runtime.modelsEndpoint }) };
}
function providerFor(models: readonly LlamaCppModel[], current: PiManagedProvider | undefined, catalog: readonly LlamaCppCatalogEntry[]): PiManagedProvider {
  return { ...current, id: MANAGED_GGUF_PROVIDER_ID, baseUrl: LLAMA_CPP_OPENAI_BASE_URL, api: "openai-completions", keyless: true,
    compat: { ...current?.compat, jokoManagedRuntime: MANAGED_GGUF_MARKER },
    models: models.map((model): PiManagedModel => {
      const saved = current?.models.find(item => item.id === model.id);
      return { ...saved, id: model.id, name: saved?.name ?? catalog.find(entry => entry.variants.some(variant => sameLlamaCppSelection(variant, model)))?.name
        ?? `${model.repository.split("/")[1]} · ${model.file.split("/").at(-1)}`, api: "openai-completions", input: saved?.input ?? ["text"],
        contextWindow: saved?.contextWindow ?? llamaCppContextSize(model) };
    }) };
}
function validateModels(models: readonly LlamaCppModel[]): void {
  if (models.length > 512 || new Set(models.map(model => model.id)).size !== models.length) throw invalid();
  for (const model of models) { assertLlamaCppSelection(model); if (model.id !== llamaCppModelId(model)) throw invalid(); }
}
function unavailable(): LocalRuntimeError { return new LocalRuntimeError("RUNTIME_ERROR", "The managed local Provider connection changed. Reconnect it in Settings."); }
function invalid(): LocalRuntimeError { return new LocalRuntimeError("MODEL_INVALID", "The selected model route or context budget is unavailable."); }
