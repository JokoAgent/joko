import type { PiManagedModel, PiManagedProvider } from "@joko/adapter-pi";
import {
  LocalRuntimeError,
  OLLAMA_OPENAI_BASE_URL,
  assertActiveOwner,
  canonicalModelName,
  isOllamaModelName,
  type ManagedRuntimeModel,
  type RuntimeOwnerGeneration
} from "@joko/local-model-runtime";

import type { ProviderCatalogManager, ProviderDescriptor } from "./credential-manager.js";

export const MANAGED_LOCAL_PROVIDER_ID = "joko-local-ollama";
const MANAGED_MARKER = "joko-local-runtime-v1";
const MAX_MANAGED_MODELS = 512;

type ProviderUpsertInput = Parameters<ProviderCatalogManager["upsert"]>[0];
type ProviderWriteOptions = Parameters<ProviderCatalogManager["upsert"]>[1];

export interface LocalModelProviderCatalog {
  list(): readonly ProviderDescriptor[];
  upsert(input: ProviderUpsertInput, options?: ProviderWriteOptions): Promise<ProviderDescriptor>;
  delete(providerId: string, options?: ProviderWriteOptions): Promise<boolean>;
}

export interface LocalModelProviderCoordinatorOptions {
  readonly providers: LocalModelProviderCatalog;
  readonly currentOwner: () => RuntimeOwnerGeneration | undefined;
  readonly bindings?: LocalModelProviderBindings;
}

export interface LocalModelProviderBinding {
  readonly providerId: string;
  readonly providerVersion: bigint;
  readonly modelIds: readonly string[];
}

export interface LocalModelProviderBindings {
  find(owner: RuntimeOwnerGeneration): Promise<LocalModelProviderBinding | undefined>;
  put(owner: RuntimeOwnerGeneration, binding: LocalModelProviderBinding): Promise<void>;
  remove(owner: RuntimeOwnerGeneration): Promise<void>;
}

export class LocalModelProviderCoordinator {
  constructor(private readonly options: LocalModelProviderCoordinatorOptions) {}

  async sync(owner: RuntimeOwnerGeneration, inputModels: readonly ManagedRuntimeModel[]): Promise<void> {
    this.assertOwner(owner);
    const models = validateModels(inputModels);
    const existing = this.options.providers.list().find((item) => item.provider.id === MANAGED_LOCAL_PROVIDER_ID);
    if (existing !== undefined && !isOwnedProvider(existing)) {
      throw new LocalRuntimeError("RUNTIME_ERROR", "The managed local Provider ID is already used by a custom Provider.");
    }
    const stillActive = () => sameOwner(this.options.currentOwner(), owner);
    if (models.length === 0) {
      if (existing !== undefined) {
        await this.options.providers.delete(MANAGED_LOCAL_PROVIDER_ID, { stillActive });
        this.assertOwner(owner);
      }
      await this.options.bindings?.remove(owner);
      this.assertOwner(owner);
      return;
    }

    const provider = managedProvider(models, existing?.provider);
    const next: ProviderUpsertInput = {
      provider,
      displayName: "Ollama (Local)",
      kind: "local_keyless",
      credentialBindings: {},
      enabled: true,
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: false,
      ...(existing === undefined ? {} : { expectedVersion: existing.version })
    };
    if (existing !== undefined && equivalentProvider(existing, next)) {
      await this.writeBinding(owner, existing, models);
      return;
    }
    const saved = await this.options.providers.upsert(next, { stillActive });
    this.assertOwner(owner);
    await this.writeBinding(owner, saved, models);
  }

  private assertOwner(owner: RuntimeOwnerGeneration): void {
    assertActiveOwner(owner, this.options.currentOwner);
  }

  private async writeBinding(
    owner: RuntimeOwnerGeneration,
    provider: ProviderDescriptor,
    models: readonly ManagedRuntimeModel[]
  ): Promise<void> {
    if (this.options.bindings === undefined) return;
    const next: LocalModelProviderBinding = {
      providerId: provider.provider.id,
      providerVersion: provider.version,
      modelIds: models.map((model) => model.id)
    };
    const current = await this.options.bindings.find(owner);
    this.assertOwner(owner);
    if (
      current?.providerId === next.providerId
      && current.providerVersion === next.providerVersion
      && JSON.stringify(current.modelIds) === JSON.stringify(next.modelIds)
    ) return;
    await this.options.bindings.put(owner, next);
    this.assertOwner(owner);
  }
}

export function isOwnedProvider(descriptor: Pick<ProviderDescriptor, "provider" | "kind" | "credentialReferenceIds">): boolean {
  const provider = descriptor.provider;
  return provider.id === MANAGED_LOCAL_PROVIDER_ID
    && descriptor.kind === "local_keyless"
    && descriptor.credentialReferenceIds.length === 0
    && provider.baseUrl === OLLAMA_OPENAI_BASE_URL
    && provider.api === "openai-completions"
    && provider.keyless === true
    && provider.apiKeyEnv === undefined
    && Object.keys(provider.headers ?? {}).length === 0
    && provider.compat?.["jokoManagedRuntime"] === MANAGED_MARKER;
}

function validateModels(models: readonly ManagedRuntimeModel[]): readonly ManagedRuntimeModel[] {
  if (models.length > MAX_MANAGED_MODELS) throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime returned too many models.");
  const byCanonicalName = new Map<string, ManagedRuntimeModel>();
  for (const model of models) {
    if (!isOllamaModelName(model.id) || model.displayName.trim() === "" || model.displayName.length > 256) {
      throw new LocalRuntimeError("MODEL_INVALID", "The local runtime returned an invalid model.");
    }
    if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new LocalRuntimeError("MODEL_INVALID", "The local runtime returned invalid model metadata.");
    }
    const key = canonicalModelName(model.id);
    if (byCanonicalName.has(key)) throw new LocalRuntimeError("MODEL_INVALID", "The local runtime returned duplicate model aliases.");
    byCanonicalName.set(key, model);
  }
  return [...byCanonicalName.values()].sort((left, right) => canonicalModelName(left.id).localeCompare(canonicalModelName(right.id), "en"));
}

function managedProvider(models: readonly ManagedRuntimeModel[], current?: PiManagedProvider): PiManagedProvider {
  const costById = new Map((current?.models ?? []).flatMap((model) => model.cost === undefined ? [] : [[canonicalModelName(model.id), model.cost] as const]));
  return {
    id: MANAGED_LOCAL_PROVIDER_ID,
    baseUrl: OLLAMA_OPENAI_BASE_URL,
    api: "openai-completions",
    keyless: true,
    compat: { jokoManagedRuntime: MANAGED_MARKER },
    models: models.map((model): PiManagedModel => ({
      id: model.id,
      name: model.displayName,
      api: "openai-completions",
      input: model.supportsImages ? ["text", "image"] : ["text"],
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(costById.get(canonicalModelName(model.id)) === undefined ? {} : { cost: costById.get(canonicalModelName(model.id))! }),
      compat: { supportsTools: model.supportsTools }
    }))
  };
}

function equivalentProvider(existing: ProviderDescriptor, next: ProviderUpsertInput): boolean {
  return existing.displayName === next.displayName
    && existing.kind === next.kind
    && existing.enabled === next.enabled
    && existing.supportsLogin === next.supportsLogin
    && existing.supportsLogout === next.supportsLogout
    && existing.supportsRefresh === next.supportsRefresh
    && existing.credentialReferenceIds.length === 0
    && JSON.stringify(existing.provider) === JSON.stringify(next.provider);
}

function sameOwner(current: RuntimeOwnerGeneration | undefined, expected: RuntimeOwnerGeneration): boolean {
  return current?.ownerId === expected.ownerId && current.generation === expected.generation;
}
