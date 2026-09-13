import type { BackendAdapter, BackendDescriptor } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackendInstanceRegistry,
  type BackendInstanceFactory,
  type BackendInstanceRegistryOptions
} from "./backend-instance-registry.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("BackendInstanceRegistry", () => {
  it("reserves every durable generation before constructing any candidate", async () => {
    const { registry, store } = fixture();
    const observations: string[] = [];
    await registry.provision([
      dynamicFactory("first", ({ generation }) => {
        const authority = store.getBackendInstanceGenerationAuthority("first");
        observations.push(`first:${generation}:${authority.highWaterGeneration}:${authority.currentGeneration}`);
        return adapter("first");
      }),
      dynamicFactory("second", ({ generation }) => {
        const first = store.getBackendInstanceGenerationAuthority("first");
        const second = store.getBackendInstanceGenerationAuthority("second");
        observations.push(`second:${generation}:${first.highWaterGeneration}:${second.highWaterGeneration}`);
        return adapter("second");
      })
    ]);

    expect(observations).toEqual(expect.arrayContaining([
      "first:1:1:undefined",
      "second:1:1:1"
    ]));
  });

  it("publishes healthy and unavailable instances independently without retaining candidate errors", async () => {
    const { registry, store } = fixture();
    const failedCreate = vi.fn((_input: { readonly instanceId: string; readonly generation: number }) => {
      throw new Error("secret-token-must-not-survive");
    });
    await registry.provision([
      factory("healthy", adapter("healthy")),
      {
        instanceId: "failed",
        adapterKind: "fixture",
        displayName: "Failed",
        create: failedCreate
      }
    ]);

    expect(failedCreate).toHaveBeenCalledWith({ instanceId: "failed", generation: 1 });
    expect(registry.availableAdapters().map((item) => item.id)).toEqual(["healthy"]);
    expect(registry.get("healthy")).toMatchObject({ generation: 1, state: "available" });
    expect(registry.get("failed")).toMatchObject({
      generation: 1,
      state: "unavailable",
      descriptor: { health: "unavailable", installationState: "error", authenticationState: "error" }
    });
    expect(store.getBackend("failed").descriptor.instanceGeneration).toBe(1);
    expect(JSON.stringify(store.getBackend("failed").descriptor)).not.toContain("secret-token-must-not-survive");
  });

  it("keeps the published generation while consuming a failed replacement reservation", async () => {
    const { registry, store } = fixture();
    const current = adapter("backend");
    const rejected = adapter("backend", { describe: async () => { throw new Error("probe rejected"); } });
    const replacement = adapter("backend");
    const candidates = [current, rejected, replacement];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    await expect(registry.replace("backend")).rejects.toThrow("failed validation");
    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(1);
    expect(store.getBackendInstanceGenerationAuthority("backend")).toMatchObject({
      currentGeneration: 1,
      highWaterGeneration: 2
    });
    expect(registry.adapter("backend")).toBe(current);
    expect(rejected.dispose).toHaveBeenCalledOnce();
    expect(current.dispose).not.toHaveBeenCalled();

    await registry.replace("backend");
    expect(registry.get("backend").generation).toBe(3);
    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(3);
  });

  it("publishes a new unavailable generation when startup cannot reconstruct the durable current", async () => {
    const { registry, store } = fixture();
    store.upsertBackend({
      ...descriptor("backend", 5),
      version: "last-published"
    });
    const rejected = adapter("backend", { describe: async () => { throw new Error("probe rejected"); } });

    await registry.provision([factory("backend", rejected)]);

    expect(registry.get("backend")).toMatchObject({
      generation: 6,
      state: "unavailable",
      descriptor: {
        version: "unknown",
        instanceGeneration: 6,
        health: "unavailable",
        installationState: "error"
      }
    });
    expect(store.getBackend("backend").descriptor).toMatchObject({
      instanceGeneration: 6,
      health: "unavailable",
      installationState: "error"
    });
    expect(store.getBackendInstanceGenerationAuthority("backend")).toMatchObject({
      currentGeneration: 6,
      highWaterGeneration: 6
    });
    expect(rejected.dispose).toHaveBeenCalledOnce();
  });

  it("rejects an unusable live candidate while retaining the running current generation", async () => {
    const { registry, store } = fixture();
    const current = adapter("backend");
    const unavailable = adapter("backend", {
      describe: async () => ({
        ...descriptor("backend"),
        health: "unavailable",
        installationState: "not_installed",
        authenticationState: "signed_out"
      })
    });
    const candidates = [current, unavailable];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    await expect(registry.replace("backend")).rejects.toThrow("failed validation");

    expect(registry.adapter("backend")).toBe(current);
    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(1);
    expect(store.getBackendInstanceGenerationAuthority("backend")).toMatchObject({
      currentGeneration: 1,
      highWaterGeneration: 2
    });
    expect(unavailable.dispose).toHaveBeenCalledOnce();
    expect(current.dispose).not.toHaveBeenCalled();
  });

  it("accepts an installed live candidate that is signed out", async () => {
    const { registry } = fixture();
    const current = adapter("backend");
    const signedOut = adapter("backend", {
      describe: async () => ({
        ...descriptor("backend"),
        health: "degraded",
        installationState: "installed",
        authenticationState: "signed_out"
      })
    });
    const candidates = [current, signedOut];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    await expect(registry.replace("backend")).resolves.toMatchObject({
      generation: 2,
      state: "available",
      descriptor: { health: "degraded", authenticationState: "signed_out" }
    });
    expect(registry.adapter("backend")).toBe(signedOut);
    expect(current.dispose).toHaveBeenCalledOnce();
  });

  it("durably publishes a validated generation before switching, draining, and disposing", async () => {
    const { registry, store } = fixture();
    const previous = adapter("backend");
    const replacement = adapter("backend");
    const candidates = [previous, replacement];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    const observations: string[] = [];
    let hostAdapter: BackendAdapter = previous;
    await registry.replace("backend", {
      preparePrevious: async ({ generation, adapter: preparing }) => {
        observations.push(`prepare:${generation}:${preparing === previous}:${store.getBackend("backend").descriptor.instanceGeneration}`);
      },
      activateCurrent: ({ generation, adapter: activated }) => {
        hostAdapter = activated;
        observations.push(`activate:${generation}:${store.getBackend("backend").descriptor.instanceGeneration}`);
      },
      drainPrevious: async ({ generation, adapter: draining }) => {
        observations.push(`drain:${[
          generation,
          draining === previous,
          registry.adapter("backend") === replacement,
          store.getBackend("backend").descriptor.instanceGeneration,
          hostAdapter === replacement
        ].join(":")}`);
      }
    });

    expect(observations).toEqual([
      "prepare:1:true:1",
      "activate:2:2",
      "drain:1:true:true:2:true"
    ]);
    expect(registry.get("backend")).toMatchObject({ generation: 2, state: "available" });
    expect(previous.dispose).toHaveBeenCalledOnce();
  });

  it("re-describes and revalidates a prepared candidate immediately before publication", async () => {
    const { registry, store } = fixture();
    const previous = adapter("backend");
    let prepared = false;
    const replacement = adapter("backend", {
      describe: vi.fn(async () => ({
        ...descriptor("backend"),
        version: prepared ? "2.0.0-prepared" : "2.0.0-probed"
      }))
    });
    const candidates = [previous, replacement];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    await registry.replace("backend", {
      preparePrevious: async () => { prepared = true; }
    });

    expect(replacement.describe).toHaveBeenCalledTimes(2);
    expect(store.getBackend("backend").descriptor).toMatchObject({
      instanceGeneration: 2,
      version: "2.0.0-prepared"
    });
  });

  it("rejects a candidate that becomes unusable during previous-generation preparation", async () => {
    const { registry, store } = fixture();
    const previous = adapter("backend");
    let prepared = false;
    const replacement = adapter("backend", {
      describe: vi.fn(async (): Promise<BackendDescriptor> => prepared
        ? {
            ...descriptor("backend"),
            health: "unavailable",
            installationState: "error",
            authenticationState: "error"
          }
        : descriptor("backend"))
    });
    const candidates = [previous, replacement];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    await expect(registry.replace("backend", {
      preparePrevious: async () => { prepared = true; }
    })).rejects.toThrow("failed validation after preparation");

    expect(registry.adapter("backend")).toBe(previous);
    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(1);
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a superseded concurrent candidate and never reuses its reservation", async () => {
    const { registry, store } = fixture();
    const initial = adapter("backend");
    const release = deferred<void>();
    const superseded = adapter("backend");
    const winner = adapter("backend");
    let invocation = 0;
    await registry.provision([dynamicFactory("backend", async () => {
      invocation += 1;
      if (invocation === 1) return initial;
      if (invocation === 2) {
        await release.promise;
        return superseded;
      }
      return winner;
    })]);

    const first = registry.replace("backend");
    const second = registry.replace("backend");
    await expect(second).resolves.toMatchObject({ generation: 3, state: "available" });
    release.resolve();
    await expect(first).rejects.toThrow("changed during replacement");

    expect(superseded.dispose).toHaveBeenCalledOnce();
    expect(registry.adapter("backend")).toBe(winner);
    expect(store.getBackendInstanceGenerationAuthority("backend")).toMatchObject({
      highWaterGeneration: 3,
      currentGeneration: 3
    });
  });

  it("rechecks process-local ownership after the final candidate description", async () => {
    const { registry } = fixture();
    const initial = adapter("backend");
    const revalidationEntered = deferred<void>();
    const releaseRevalidation = deferred<void>();
    let descriptions = 0;
    const superseded = adapter("backend", {
      describe: vi.fn(async () => {
        descriptions += 1;
        if (descriptions === 2) {
          revalidationEntered.resolve();
          await releaseRevalidation.promise;
        }
        return descriptor("backend");
      })
    });
    const winner = adapter("backend");
    const candidates = [initial, superseded, winner];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    const first = registry.replace("backend");
    await revalidationEntered.promise;
    await registry.replace("backend");
    releaseRevalidation.resolve();

    await expect(first).rejects.toThrow("being revalidated");
    expect(registry.adapter("backend")).toBe(winner);
    expect(superseded.dispose).toHaveBeenCalledOnce();
  });

  it("keeps a durably switched replacement successful when retired-instance cleanup fails", async () => {
    const { registry, store } = fixture();
    const previous = adapter("backend");
    vi.mocked(previous.dispose).mockRejectedValueOnce(new Error("private cleanup detail"));
    const replacement = adapter("backend");
    const candidates = [previous, replacement];
    const cleanupFailure = vi.fn();
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    await expect(registry.replace("backend", {
      onPreviousCleanupFailure: cleanupFailure
    })).resolves.toMatchObject({ generation: 2, state: "available" });

    expect(registry.adapter("backend")).toBe(replacement);
    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(2);
    expect(cleanupFailure).toHaveBeenCalledExactlyOnceWith({ instanceId: "backend", generation: 1 });
  });

  it("bounds retired-generation drain and cleanup while an exact-owner janitor escalates and retries", async () => {
    const { registry, store } = fixture({
      retirementStepTimeoutMs: 5,
      retirementRetryDelayMs: 0,
      retirementAttempts: 2
    });
    const never = deferred<void>();
    const forceDispose = vi.fn()
      .mockRejectedValueOnce(new Error("first hard-retirement attempt failed"))
      .mockResolvedValueOnce(undefined);
    const previous = adapter("backend", {
      dispose: vi.fn(() => never.promise),
      forceDispose
    });
    const replacement = adapter("backend");
    const candidates = [previous, replacement];
    const cleanupFailure = vi.fn();
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    await expect(registry.replace("backend", {
      drainPrevious: () => never.promise,
      onPreviousCleanupFailure: cleanupFailure
    })).resolves.toMatchObject({ generation: 2, state: "available" });

    expect(registry.adapter("backend")).toBe(replacement);
    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(2);
    expect(cleanupFailure).toHaveBeenCalledExactlyOnceWith({ instanceId: "backend", generation: 1 });
    await vi.waitFor(() => expect(forceDispose).toHaveBeenCalledTimes(2));
  });

  it("refreshes a live descriptor durably without changing its process generation", async () => {
    const { registry, store } = fixture();
    const runtime = adapter("backend");
    await registry.provision([factory("backend", runtime)]);
    vi.mocked(runtime.describe).mockResolvedValueOnce({
      ...descriptor("backend", 99),
      authenticationState: "authenticated",
      health: "healthy",
      models: [{
        providerId: "native",
        modelId: "current-model",
        displayName: "Current model",
        api: "native",
        contextWindow: 1,
        maxOutputTokens: 1,
        supportsImages: false,
        thinkingLevels: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }]
    });

    await expect(registry.refresh("backend")).resolves.toMatchObject({
      generation: 1,
      descriptor: {
        authenticationState: "authenticated",
        models: [{ modelId: "current-model" }]
      }
    });
    expect(store.getBackend("backend").descriptor).toMatchObject({
      instanceGeneration: 1,
      authenticationState: "authenticated",
      models: [{ modelId: "current-model" }]
    });
    expect(registry.adapter("backend")).toBe(runtime);
  });

  it("does not let a delayed descriptor refresh overwrite a replacement", async () => {
    const { registry } = fixture();
    const refreshEntered = deferred<BackendDescriptor>();
    const previous = adapter("backend");
    const replacement = adapter("backend");
    const candidates = [previous, replacement];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);
    vi.mocked(previous.describe).mockImplementationOnce(() => refreshEntered.promise);

    const refresh = registry.refresh("backend");
    await registry.replace("backend");
    refreshEntered.resolve(descriptor("backend", 1));

    await expect(refresh).rejects.toThrow("changed while its descriptor was being refreshed");
    expect(registry.adapter("backend")).toBe(replacement);
    expect(registry.get("backend").generation).toBe(2);
  });

  it("rejects duplicate public instance identities before reserving or constructing candidates", async () => {
    const { registry, store } = fixture();
    const create = vi.fn((_input: { readonly instanceId: string; readonly generation: number }) => adapter("duplicate"));
    await expect(registry.provision([
      { instanceId: "duplicate", adapterKind: "fixture", displayName: "First", create },
      { instanceId: "duplicate", adapterKind: "fixture", displayName: "Second", create }
    ])).rejects.toThrow("Duplicate Backend instance");
    expect(create).not.toHaveBeenCalled();
    expect(() => store.getBackendInstanceGenerationAuthority("duplicate")).toThrow();
  });

  it("advances the durable high-water mark across registry restarts", async () => {
    const { registry: first, store } = fixture();
    await first.provision([
      factory("pi", adapter("pi")),
      factory("codex", adapter("codex"))
    ]);
    await first.dispose();

    const second = new BackendInstanceRegistry(store);
    await second.provision([
      factory("pi", adapter("pi")),
      factory("codex", adapter("codex"))
    ]);

    expect(second.availableAdapters().map((item) => item.id)).toEqual(["pi", "codex"]);
    expect(second.get("pi").generation).toBe(2);
    expect(second.get("codex").generation).toBe(2);
  });

  it("passes the reserved identity and generation into construction", async () => {
    const { registry, store } = fixture();
    store.upsertBackend(descriptor("backend", Number.MAX_SAFE_INTEGER - 7));
    const create = vi.fn((_input: { readonly instanceId: string; readonly generation: number }) => adapter("backend"));

    await registry.provision([{
      instanceId: "backend",
      adapterKind: "fixture",
      displayName: "Backend",
      create
    }]);

    expect(create).toHaveBeenCalledWith({ instanceId: "backend", generation: Number.MAX_SAFE_INTEGER - 6 });
  });

  it("keeps the provisioned factory and Adapter kind immutable across replacement", async () => {
    const { registry } = fixture();
    const first = adapter("backend");
    const second = adapter("backend");
    const create = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    await registry.provision([dynamicFactory("backend", create)]);

    await registry.replace("backend");

    expect(create).toHaveBeenNthCalledWith(2, { instanceId: "backend", generation: 2 });
    expect(registry.adapter("backend")).toBe(second);
  });

  it("settles a previous-generation background callback before candidate revalidation and publication", async () => {
    const { registry, store } = fixture();
    const quiesceEntered = deferred<void>();
    const callbackSettled = deferred<void>();
    let settled = false;
    const previous = adapter("backend", {
      quiesceForReplacement: vi.fn(async () => {
        quiesceEntered.resolve(undefined);
        await callbackSettled.promise;
        settled = true;
      })
    });
    const candidateObservations: boolean[] = [];
    const candidate = adapter("backend", {
      describe: vi.fn(async () => {
        candidateObservations.push(settled);
        return descriptor("backend");
      })
    });
    const candidates = [previous, candidate];
    await registry.provision([dynamicFactory("backend", () => candidates.shift()!)]);

    const replacing = registry.replace("backend");
    await quiesceEntered.promise;

    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(1);
    callbackSettled.resolve(undefined);
    await replacing;

    expect(candidateObservations).toEqual([false, true]);
    expect(store.getBackend("backend").descriptor.instanceGeneration).toBe(2);
  });

  it("fails closed before construction when the safe-integer generation space is exhausted", async () => {
    const { registry, store } = fixture();
    store.upsertBackend(descriptor("backend", Number.MAX_SAFE_INTEGER));
    const create = vi.fn((_input: { readonly instanceId: string; readonly generation: number }) => adapter("backend"));

    await expect(registry.provision([{
      instanceId: "backend",
      adapterKind: "fixture",
      displayName: "Backend",
      create
    }])).rejects.toThrow("Backend instance generation is exhausted");
    expect(create).not.toHaveBeenCalled();
  });
});

function fixture(
  options: BackendInstanceRegistryOptions = {}
): { readonly registry: BackendInstanceRegistry; readonly store: OperationalStore } {
  const store = new OperationalStore(":memory:");
  stores.push(store);
  return { registry: new BackendInstanceRegistry(store, options), store };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function factory(instanceId: string, value: BackendAdapter): BackendInstanceFactory {
  return dynamicFactory(instanceId, () => value);
}

function dynamicFactory(
  instanceId: string,
  create: BackendInstanceFactory["create"]
): BackendInstanceFactory {
  return {
    instanceId,
    adapterKind: "fixture",
    displayName: instanceId,
    create
  };
}

function descriptor(id: string, instanceGeneration = 0): BackendDescriptor {
  return {
    id,
    adapterKind: "fixture",
    instanceGeneration,
    displayName: id,
    version: "1.0.0",
    health: "healthy",
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  };
}

function adapter(
  id: string,
  overrides: Partial<Pick<
    BackendAdapter,
    "describe" | "dispose" | "forceDispose" | "quiesceForReplacement"
  >> = {}
): BackendAdapter {
  return {
    id,
    describe: vi.fn(async () => descriptor(id)),
    dispose: vi.fn(async () => undefined),
    ...overrides
  } as unknown as BackendAdapter;
}
