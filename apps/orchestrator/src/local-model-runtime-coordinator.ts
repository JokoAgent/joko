import type { PiManagedModel, PiManagedProvider } from "@joko/adapter-pi";
import {
  LocalRuntimeError,
  OLLAMA_LOOPBACK_ORIGIN,
  OLLAMA_OPENAI_BASE_URL,
  assertActiveOwner,
  canonicalModelName,
  isOllamaModelName,
  type ManagedRuntimeModel,
  type RuntimeOwnerGeneration
} from "@joko/local-model-runtime";

import type { ManagedProviderRuntimeInput, ProviderCatalogManager, ProviderDescriptor } from "./credential-manager.js";

export const MANAGED_LOCAL_PROVIDER_ID = "joko-local-ollama";
const MANAGED_MARKER = "joko-local-runtime-v1";
const MAX_MANAGED_MODELS = 512;

type OllamaProtocol = "openai-completions" | "anthropic-messages";
export type LocalModelProviderCatalog = Pick<ProviderCatalogManager, "listConfigurations" | "delete" | "deleteRuntime" | "upsertConfiguration">;

export interface LocalModelProviderCoordinatorOptions {
  readonly providers: LocalModelProviderCatalog;
  readonly backendId: string;
  readonly claudeBackendId?: string;
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

  routes(owner: RuntimeOwnerGeneration): readonly { readonly backendId: string; readonly providerId: string }[] {
    this.assertOwner(owner);
    return (this.configuration()?.runtimes ?? []).filter(runtime => this.isOwnedRuntime(runtime))
      .map(runtime => ({ backendId: runtime.backendId, providerId: runtime.provider.id }));
  }

  ownsModel(owner: RuntimeOwnerGeneration, backendId: string, modelId: string): boolean {
    this.assertOwner(owner);
    const runtime = this.configuration()?.runtimes.find(candidate => candidate.backendId === backendId);
    return runtime !== undefined && runtime.enabled && this.isOwnedRuntime(runtime)
      && runtime.provider.models.some(model => model.id === modelId);
  }

  async sync(owner: RuntimeOwnerGeneration, inputModels: readonly ManagedRuntimeModel[], version?: string): Promise<readonly string[]> {
    this.assertOwner(owner);
    const models = validateModels(inputModels);
    const configuration = this.configuration();
    const previous = configuration?.runtimes ?? [];
    const owned = previous.filter(runtime => this.isOwnedRuntime(runtime));
    const pi = previous.find(runtime => runtime.backendId === this.options.backendId);
    if ((pi !== undefined && !this.isOwnedRuntime(pi))
      || (models.length > 0 && owned.length !== previous.length)) {
      throw new LocalRuntimeError("RUNTIME_ERROR", "The managed local Provider ID is already used by a custom Provider.");
    }
    const stillActive = () => sameOwner(this.options.currentOwner(), owner);
    const stillCurrent = () => {
      if (!stillActive()) return false;
      const current = this.configuration()?.runtimes ?? [];
      return current.length === previous.length && previous.every(runtime => current.some(candidate =>
        candidate.backendId === runtime.backendId && candidate.version === runtime.version));
    };
    if (models.length === 0) {
      if (configuration !== undefined && owned.length === previous.length) {
        await this.options.providers.delete(MANAGED_LOCAL_PROVIDER_ID, { expectedVersion: configuration.version, stillActive: stillCurrent });
      } else {
        for (const runtime of owned) {
          await this.options.providers.deleteRuntime(runtime.backendId, MANAGED_LOCAL_PROVIDER_ID, {
            expectedVersion: runtime.version, stillActive
          });
        }
      }
      this.assertOwner(owner);
      await this.options.bindings?.remove(owner);
      this.assertOwner(owner);
      return owned.map(runtime => runtime.backendId);
    }

    const runtimes = [providerRuntime(this.options.backendId, "openai-completions", models, pi?.provider)];
    const claudeBackendId = this.options.claudeBackendId;
    if (claudeBackendId !== undefined) {
      const compatible = models.filter(model => supportsClaudeOllamaModel(version, model.supportsTools, model.requiredRuntimeVersion));
      const current = previous.find(runtime => runtime.backendId === claudeBackendId);
      if (compatible.length > 0) runtimes.push(providerRuntime(claudeBackendId, "anthropic-messages", compatible, current?.provider));
    }
    if (pi !== undefined && previous.length === runtimes.length && runtimes.every(runtime => previous.some(candidate =>
      candidate.backendId === runtime.backendId && JSON.stringify(candidate.provider) === JSON.stringify(runtime.provider)))) {
      await this.writeBinding(owner, pi, models);
      return [];
    }
    await this.options.providers.upsertConfiguration({
      providerId: MANAGED_LOCAL_PROVIDER_ID,
      displayName: configuration?.displayName ?? "Ollama (Local)",
      kind: "local_keyless",
      enabled: configuration?.enabled ?? true,
      expectedVersion: configuration?.version ?? 0n,
      runtimes
    }, { stillActive: stillCurrent });
    this.assertOwner(owner);
    const saved = this.configuration()?.runtimes.find(runtime => runtime.backendId === this.options.backendId);
    if (saved === undefined || !this.isOwnedRuntime(saved)) throw new LocalRuntimeError("RUNTIME_ERROR", "The managed Ollama Provider changed during registration.");
    await this.writeBinding(owner, saved, models);
    return [...new Set([...runtimes, ...owned].map(runtime => runtime.backendId))];
  }

  private configuration() {
    return this.options.providers.listConfigurations().find(item => item.providerId === MANAGED_LOCAL_PROVIDER_ID);
  }

  private isOwnedRuntime(runtime: ProviderDescriptor): boolean {
    if (runtime.backendId === this.options.backendId) return isOwnedProvider(runtime, "openai-completions");
    return runtime.backendId === this.options.claudeBackendId && isOwnedProvider(runtime, "anthropic-messages");
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

export function isOwnedProvider(
  descriptor: Pick<ProviderDescriptor, "provider" | "kind" | "credentialReferenceIds" | "requestPath">,
  protocol: OllamaProtocol = "openai-completions"
): boolean {
  const provider = descriptor.provider;
  return provider.id === MANAGED_LOCAL_PROVIDER_ID
    && descriptor.kind === "local_keyless"
    && descriptor.credentialReferenceIds.length === 0
    && provider.baseUrl === (protocol === "anthropic-messages" ? OLLAMA_LOOPBACK_ORIGIN : OLLAMA_OPENAI_BASE_URL)
    && provider.api === protocol
    && (protocol !== "anthropic-messages" || descriptor.requestPath === undefined)
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

function providerRuntime(
  backendId: string, protocol: OllamaProtocol, models: readonly ManagedRuntimeModel[], current?: PiManagedProvider
): ManagedProviderRuntimeInput {
  const costById = new Map((current?.models ?? []).flatMap((model) => model.cost === undefined ? [] : [[canonicalModelName(model.id), model.cost] as const]));
  return {
    backendId,
    credentialOrigin: "",
    credentialBindings: {},
    provider: {
      id: MANAGED_LOCAL_PROVIDER_ID,
      baseUrl: protocol === "anthropic-messages" ? OLLAMA_LOOPBACK_ORIGIN : OLLAMA_OPENAI_BASE_URL,
      api: protocol,
      keyless: true,
      compat: { jokoManagedRuntime: MANAGED_MARKER },
      models: models.map((model): PiManagedModel => {
        const cost = costById.get(canonicalModelName(model.id));
        return {
          id: model.id,
          name: model.displayName,
          api: protocol,
          input: model.supportsImages ? ["text", "image"] : ["text"],
          ...(protocol === "anthropic-messages" ? { supportsTools: model.supportsTools } : {}),
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(cost === undefined ? {} : { cost }),
          compat: { supportsTools: model.supportsTools }
        };
      })
    }
  };
}

export function supportsClaudeOllamaModel(version: string | undefined, supportsTools: boolean, requires: string | undefined): boolean {
  if (!supportsTools) return false;
  const current = parseVersion(version);
  if (current === undefined || !atLeastVersion(current, [0, 14, 0])) return false;
  if (requires === undefined) return true;
  const required = parseVersion(requires);
  return required !== undefined && atLeastVersion(current, required);
}

function parseVersion(value: string | undefined): readonly number[] | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(value ?? "");
  if (match === null) return undefined;
  const version = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function atLeastVersion(actual: readonly number[], minimum: readonly number[]): boolean {
  for (const [index, part] of minimum.entries()) {
    const found = actual[index]!;
    if (found !== part) return found > part;
  }
  return true;
}

function sameOwner(current: RuntimeOwnerGeneration | undefined, expected: RuntimeOwnerGeneration): boolean {
  return current?.ownerId === expected.ownerId && current.generation === expected.generation;
}
