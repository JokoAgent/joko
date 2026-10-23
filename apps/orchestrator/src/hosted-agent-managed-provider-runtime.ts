import type { ManagedProviderRouteBinding, ManagedProviderRouteOwner, ManagedProviderRuntimePort, ProviderRuntimeSupport } from "@joko/core";
import type { HostedAgentBackendFactory } from "./hosted-agent-runtime.js";
import type { ProviderCatalogManager } from "./credential-manager.js";
import { ManagedProviderProxy } from "./managed-provider-proxy.js";

type Creation = Parameters<HostedAgentBackendFactory["create"]>[0];

/** A native run's private credential transport. The Source task is not a local
 * product Session, so the ordinary Store-backed provider proxy cannot own it. */
export async function createHostedAgentManagedProviderRuntime(options: {
  readonly creation: Creation;
  readonly backendId: string;
  readonly providers: ProviderCatalogManager;
  readonly support: ProviderRuntimeSupport;
  readonly fetch?: typeof fetch;
}): Promise<{ readonly runtime: ManagedProviderRuntimePort; close(): Promise<void> }> {
  const { creation } = options, allowed = new Set(creation.providerIds);
  const assertCurrent = () => { creation.signal.throwIfAborted(); creation.execution.assertCurrent(); };
  const assertModel = (providerId: string, modelId: string) => {
    assertCurrent();
    if (!allowed.has(providerId) || creation.trust === "guest" && (providerId !== creation.providerId || !creation.modelIds.includes(modelId))) {
      throw new Error("The hosted Provider does not allow this model.");
    }
    creation.assertModelAllowed(providerId, modelId);
  };
  const assertOwner = (owner: ManagedProviderRouteOwner) => {
    assertCurrent(); const expected = creation.nativeOwner;
    if (owner.backendId !== options.backendId || owner.backendInstanceGeneration !== expected.backendInstanceGeneration
      || owner.sessionId !== expected.sessionId || owner.targetId !== expected.targetId || owner.sessionGeneration !== expected.generation) {
      throw new Error("The private native Provider owner changed.");
    }
  };
  const proxy = new ManagedProviderProxy({ providers: options.providers, ...(options.fetch ? { fetch: options.fetch } : {}), assertOwner });
  try {
    await proxy.start(); assertCurrent();
    const base = proxy.createRuntime({ backendId: options.backendId, generation: creation.nativeOwner.backendInstanceGeneration,
      support: options.support, assertCurrent });
    const permitted = (providerId: string, modelId?: string) => {
      try { if (modelId) assertModel(providerId, modelId); else { assertCurrent(); if (!allowed.has(providerId)) return false; } return true; }
      catch { return false; }
    };
    const wrap = (binding: ManagedProviderRouteBinding): ManagedProviderRouteBinding => ({
      ...binding,
      assertCurrent() { assertModel(binding.providerId, binding.model.modelId); binding.assertCurrent(); },
      activate(input) { assertModel(binding.providerId, binding.model.modelId); return binding.activate({ ...input,
        assertCurrent() { assertModel(binding.providerId, binding.model.modelId); input.assertCurrent(); } }); },
      ...(binding.authorizeSubtask ? { authorizeSubtask(input: Parameters<NonNullable<ManagedProviderRouteBinding["authorizeSubtask"]>>[0]) {
        assertModel(binding.providerId, input.modelId);
        return binding.authorizeSubtask!({ ...input, assertCurrent() { assertModel(binding.providerId, input.modelId); input.assertCurrent(); } });
      } } : {})
    });
    const runtime: ManagedProviderRuntimePort = {
      support: base.support, environment: base.environment, secretEnvironmentNames: base.secretEnvironmentNames,
      dispose: () => base.dispose(),
      hasProvider: providerId => permitted(providerId) && base.hasProvider(providerId),
      listProviders: () => base.listProviders().filter(provider => permitted(provider.providerId)),
      listModels: () => base.listModels().filter(model => permitted(model.providerId, model.modelId)),
      getThinkingLevelMap(providerId, modelId) { assertModel(providerId, modelId); return base.getThinkingLevelMap(providerId, modelId); },
      async prepare(input) { assertOwner(input); assertModel(input.providerId, input.modelId); return wrap(await base.prepare(input)); }
    };
    return { runtime, close: () => proxy.close() };
  } catch (error) { await proxy.close(); throw error; }
}
