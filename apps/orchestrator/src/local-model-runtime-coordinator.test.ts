import type { PiManagedProvider } from "@joko/adapter-pi";
import type { ManagedRuntimeModel, RuntimeOwnerGeneration } from "@joko/local-model-runtime";
import { describe, expect, it, vi } from "vitest";

import type { ProviderDescriptor } from "./credential-manager.js";
import {
  LocalModelProviderCoordinator,
  MANAGED_LOCAL_PROVIDER_ID,
  isOwnedProvider,
  type LocalModelProviderCatalog
} from "./local-model-runtime-coordinator.js";

function model(id: string, overrides: Partial<ManagedRuntimeModel> = {}): ManagedRuntimeModel {
  return { id, displayName: id, supportsTools: false, supportsImages: false, ...overrides };
}

function descriptor(provider: PiManagedProvider, overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    provider,
    displayName: "Ollama (Local)",
    kind: "local_keyless",
    enabled: true,
    supportsLogin: false,
    supportsLogout: false,
    supportsRefresh: false,
    version: 1n,
    updatedAt: 1,
    credentialReferenceIds: [],
    authenticationState: "not_required",
    ...overrides
  };
}

class FakeProviders implements LocalModelProviderCatalog {
  readonly upserts = vi.fn();
  readonly deletes = vi.fn();
  values: ProviderDescriptor[] = [];

  list(): readonly ProviderDescriptor[] {
    return this.values;
  }

  async upsert(input: Parameters<LocalModelProviderCatalog["upsert"]>[0], options?: Parameters<LocalModelProviderCatalog["upsert"]>[1]): Promise<ProviderDescriptor> {
    if (options?.stillActive?.() === false) throw new Error("stale");
    const next = descriptor(input.provider, {
      displayName: input.displayName,
      kind: input.kind,
      enabled: input.enabled,
      supportsLogin: input.supportsLogin,
      supportsLogout: input.supportsLogout,
      supportsRefresh: input.supportsRefresh,
      version: (this.values.find((item) => item.provider.id === input.provider.id)?.version ?? 0n) + 1n
    });
    this.values = [...this.values.filter((item) => item.provider.id !== input.provider.id), next];
    this.upserts(input, options);
    return next;
  }

  async delete(providerId: string, options?: Parameters<LocalModelProviderCatalog["delete"]>[1]): Promise<boolean> {
    if (options?.stillActive?.() === false) throw new Error("stale");
    const found = this.values.some((item) => item.provider.id === providerId);
    this.values = this.values.filter((item) => item.provider.id !== providerId);
    this.deletes(providerId, options);
    return found;
  }
}

describe("LocalModelProviderCoordinator", () => {
  it("creates one owner-managed keyless Provider without inventing prices", async () => {
    const owner = { ownerId: "owner-a", generation: 1 };
    const providers = new FakeProviders();
    const coordinator = new LocalModelProviderCoordinator({ providers, currentOwner: () => owner });
    await coordinator.sync(owner, [model("model-a", { contextWindow: 32768, supportsTools: true, supportsImages: true })]);

    const created = providers.values[0]!;
    expect(isOwnedProvider(created)).toBe(true);
    expect(created.provider).toMatchObject({
      id: MANAGED_LOCAL_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:11434/v1",
      keyless: true,
      models: [{
        id: "model-a",
        contextWindow: 32768,
        input: ["text", "image"],
        compat: { supportsTools: true }
      }]
    });
    expect(created.provider.models[0]).not.toHaveProperty("cost");
    expect(created.credentialReferenceIds).toEqual([]);
  });

  it("preserves an explicit owner price while replacing runtime-owned metadata", async () => {
    const owner = { ownerId: "owner-a", generation: 1 };
    const providers = new FakeProviders();
    const coordinator = new LocalModelProviderCoordinator({ providers, currentOwner: () => owner });
    await coordinator.sync(owner, [model("model-a")]);
    const current = providers.values[0]!;
    providers.values = [descriptor({
      ...current.provider,
      models: [{
        ...current.provider.models[0]!,
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 }
      }]
    }, { version: 2n })];
    await coordinator.sync(owner, [model("model-a", { contextWindow: 65536 })]);
    expect(providers.values[0]!.provider.models[0]).toMatchObject({
      contextWindow: 65536,
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 }
    });
  });

  it("removes the managed Provider when its final installed model disappears", async () => {
    const owner = { ownerId: "owner-a", generation: 1 };
    const providers = new FakeProviders();
    const coordinator = new LocalModelProviderCoordinator({ providers, currentOwner: () => owner });
    await coordinator.sync(owner, [model("model-a")]);
    await coordinator.sync(owner, []);
    expect(providers.values).toEqual([]);
    expect(providers.deletes).toHaveBeenCalledWith(MANAGED_LOCAL_PROVIDER_ID, expect.objectContaining({ stillActive: expect.any(Function) }));
  });

  it("records and removes the durable Provider ownership binding", async () => {
    const owner = { ownerId: "owner-a", generation: 1 };
    const providers = new FakeProviders();
    let binding: { providerId: string; providerVersion: bigint; modelIds: readonly string[] } | undefined;
    const bindings = {
      find: vi.fn(async () => binding),
      put: vi.fn(async (_owner: typeof owner, value: typeof binding) => { binding = value; }),
      remove: vi.fn(async () => { binding = undefined; })
    };
    const coordinator = new LocalModelProviderCoordinator({ providers, currentOwner: () => owner, bindings });
    await coordinator.sync(owner, [model("model-a")]);
    expect(binding).toEqual({
      providerId: MANAGED_LOCAL_PROVIDER_ID,
      providerVersion: 1n,
      modelIds: ["model-a"]
    });
    await coordinator.sync(owner, []);
    expect(binding).toBeUndefined();
    expect(bindings.remove).toHaveBeenCalledWith(owner);
  });

  it("does not overwrite a custom Provider that occupies the managed ID", async () => {
    const owner = { ownerId: "owner-a", generation: 1 };
    const providers = new FakeProviders();
    providers.values = [descriptor({
      id: MANAGED_LOCAL_PROVIDER_ID,
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      keyless: true,
      models: [{ id: "custom" }]
    }, { kind: "custom_endpoint" })];
    const coordinator = new LocalModelProviderCoordinator({ providers, currentOwner: () => owner });
    await expect(coordinator.sync(owner, [model("model-a")])).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
    expect(providers.upserts).not.toHaveBeenCalled();
  });

  it("evaluates the owner fence inside the serialized Provider mutation", async () => {
    const owner = { ownerId: "owner-a", generation: 1 };
    let activeOwner: RuntimeOwnerGeneration = owner;
    const providers = new FakeProviders();
    providers.upsert = async (input, options) => {
      activeOwner = { ownerId: "owner-a", generation: 2 };
      if (options?.stillActive?.() === false) throw new Error("stale");
      return descriptor(input.provider);
    };
    const coordinator = new LocalModelProviderCoordinator({ providers, currentOwner: () => activeOwner });
    await expect(coordinator.sync(owner, [model("model-a")])).rejects.toThrow("stale");
    expect(providers.values).toEqual([]);
  });

  it("rejects invalid and duplicate model aliases before any Provider write", async () => {
    const owner = { ownerId: "owner-a", generation: 1 };
    const providers = new FakeProviders();
    const coordinator = new LocalModelProviderCoordinator({ providers, currentOwner: () => owner });
    await expect(coordinator.sync(owner, [model("../escape")])).rejects.toMatchObject({ code: "MODEL_INVALID" });
    await expect(coordinator.sync(owner, [model("model-a"), model("model-a:latest")])).rejects.toMatchObject({ code: "MODEL_INVALID" });
    expect(providers.upserts).not.toHaveBeenCalled();
  });
});
