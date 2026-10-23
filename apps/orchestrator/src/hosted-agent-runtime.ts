import type { BackendAdapter, BackendDescriptor, BlobRef, CapabilityManifest, ProviderModel, HostedExecution, NativeTextInferenceInput } from "@joko/core";
import type { HostedNativeInferenceRequest } from "@joko/adapter-hosted";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { HostedAgentStore, type HostedNativeProviderGrantOwner, type OperationalStore } from "@joko/store";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import type { ConnectionManager } from "./connection-manager.js";
import { HostedAgentHost, HostedAgentHostError, type HostedAgentHostOptions, type HostedAgentPrincipal, type HostedAgentOpen } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentSettings } from "./hosted-agent-settings.js";
import type { HostedAgentConnectOptions, HostedAgentLifecycleEndpointPort } from "./hosted-agent-connect-service.js";
import { toProtoCapability, toProtoModelDescriptor } from "./proto-mapper.js";
import { HOSTED_AGENT_WIRE_FORMAT } from "./hosted-agent-wire.js";
import { purgeHostedAgentStorage } from "./hosted-agent-run.js";
import type { HostedAgentNativeMcp } from "./hosted-agent-native-mcp.js";

export interface HostedAgentBackendFactory {
  readonly backendId: string;
  readonly displayName?: string;
  readonly providerIds: () => readonly string[];
  readonly providerDisplayName?: (providerId: string) => string;
  readonly capabilities?: () => CapabilityManifest;
  readonly version?: () => string;
  readonly isolatedGuests?: () => boolean;
  readonly describe?: () => Pick<BackendDescriptor, "adapterKind" | "providers">;
  /** Current enabled, authenticated models on the actual native Provider node. */
  readonly models: () => readonly ProviderModel[];
  readonly create: (input: HostedAgentBackendCreation) => BackendAdapter | Promise<BackendAdapter>;
}
export interface HostedAgentBackendCreation {
  readonly home: string; readonly trust: "owner" | "guest"; readonly providerId: string;
  readonly sourceMcp?: HostedAgentNativeMcp;
  readonly providerIds: readonly string[]; readonly modelIds: readonly string[]; readonly signal: AbortSignal; readonly execution: HostedExecution;
  readonly nativeOwner: { readonly sessionId: string; readonly targetId: string; readonly generation: number; readonly backendInstanceGeneration: number };
  readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
  readonly assertModelAllowed: (providerId: string, modelId: string) => void;
}
export interface HostedAgentRuntimeOptions {
  readonly inferNativeText?: (backendId: string, input: NativeTextInferenceInput) => Promise<string>;
  readonly store: OperationalStore;
  readonly root: string;
  readonly nodeId?: string;
  readonly artifactCapacityBytes: number;
  readonly connections: ConnectionManager;
  readonly factories: readonly HostedAgentBackendFactory[];
  readonly authenticateGuest?: (context: HandlerContext) => HostedAgentPrincipal | Promise<HostedAgentPrincipal>;
  readonly decorateCatalog?: (value: contract.GetHostedAgentCatalogResponse) => contract.GetHostedAgentCatalogResponse;
  readonly resolveSharedProvider?: (backendId: string, providerId: string) => { readonly catalog: contract.HostedAgentBackendCatalog;
    readonly models: readonly ProviderModel[]; readonly assertCurrent: () => void } | undefined;
}

/** Composes native process ownership, the durable native journal and current
 * remote permissions. Factory credentials and networking stay on this node. */
export class HostedAgentRuntime {
  readonly settings: HostedAgentSettings;
  readonly slots: HostedAgentSessionSlots;
  readonly host: HostedAgentHost;
  readonly #factories: ReadonlyMap<string, HostedAgentBackendFactory>;
  readonly #options: HostedAgentRuntimeOptions;
  #endpoint?: HostedAgentLifecycleEndpointPort;
  get endpoint(): HostedAgentLifecycleEndpointPort { return this.#endpoint ?? this.host; }
  installEndpoint(endpoint: HostedAgentLifecycleEndpointPort): void {
    if (this.#endpoint && this.#endpoint !== endpoint) throw new Error("The native endpoint owner is already installed."); this.#endpoint = endpoint;
  }
  constructor(options: HostedAgentRuntimeOptions) {
    this.#options = options; this.settings = new HostedAgentSettings(options.store); this.slots = new HostedAgentSessionSlots(() => this.settings.limits());
    this.#factories = new Map(options.factories.map(factory => [factory.backendId, factory]));
    if (this.#factories.size !== options.factories.length) throw new Error("Hosted Agent Backend factories conflict.");
    this.host = new HostedAgentHost({ authorize: this.#authorize, infer: this.#infer, authorizeInference: this.#inferenceAccess });
  }
  connectOptions(): HostedAgentConnectOptions {
    const runtime = this;
    return { get host() { return runtime.endpoint; }, authenticate: context => this.authenticate(context), catalog: principal => {
      principal.assertCurrent();
      // A future shared catalog must be derived from its original issuer's
      // grant. An owner catalog must never be borrowed by a task-sharing guest.
      if (principal.trust === "guest") {
        const grant = principal.providerGrant; if (!grant) throw new HostedAgentHostError("ACCESS_DENIED"); grant.assertCurrent();
        const provider = this.shareableProvider(grant.backendId, grant.providerId);
        return create(contract.GetHostedAgentCatalogResponseSchema, { format: HOSTED_AGENT_WIRE_FORMAT, remoteControlEnabled: true,
          backends: [{ ...provider.catalog, providers: provider.catalog.providers.map(item => ({ ...item,
            models: item.models.filter(model => grant.modelIds.includes(model.key?.modelId ?? "")) })) }] });
      }
      const snapshot = this.settings.snapshot();
      const catalog = create(contract.GetHostedAgentCatalogResponseSchema, { format: HOSTED_AGENT_WIRE_FORMAT,
        remoteControlEnabled: snapshot.value.remoteControlEnabled,
        backends: [...this.#factories.values()].map(factory => {
          const models = factory.models();
          return { backendId: factory.backendId, instanceGeneration: BigInt(this.#options.store.getBackend(factory.backendId).descriptor.instanceGeneration), displayName: factory.displayName ?? factory.backendId, nativeAdapterKind: factory.describe?.().adapterKind ?? "", nodeId: this.#options.nodeId ?? "",
            capabilities: [...(factory.capabilities?.().values() ?? [])].map(toProtoCapability), version: factory.version?.() ?? "",
            providers: factory.providerIds().map(providerId => {
              const current = models.filter(model => model.providerId === providerId);
              const descriptor = factory.describe?.().providers?.find(provider => provider.providerId === providerId);
              return { providerId, displayName: factory.providerDisplayName?.(providerId) ?? providerId,
                accessKind: descriptor?.accessKind ?? "", accessProduct: descriptor?.accessProduct ?? "",
                remoteInvocationEnabled: this.settings.providerEnabled(factory.backendId, providerId), connected: current.length > 0,
                models: current.map(model => toProtoModelDescriptor(factory.backendId, model)) };
            }) };
        }) });
      return this.#options.decorateCatalog?.(catalog) ?? catalog;
    },
      management: { settings: this.settings, slots: this.slots, assertProviderExists: (backendId, providerId) => {
        if (!this.#factories.get(backendId)?.providerIds().includes(providerId)) throw new HostedAgentHostError("UNAVAILABLE");
      }, onChanged: () => this.endpoint.sweep() } };
  }
  async close(): Promise<void> {
    // The facade owns onward native cleanups; base retains the actual local
    // processes. An uncertain onward close must not skip local cleanup.
    const errors: unknown[] = [];
    if (this.#endpoint && this.#endpoint !== this.host) { try { await this.#endpoint.dispose(); } catch (error) { errors.push(error); } }
    try { await this.host.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native endpoint cleanup could not be confirmed.");
  }
  /** Reconcile private data left by a previously confirmed closed guest.
   * A crash with an unknown native outcome keeps its exact journal fenced. */
  async purgeClosedProviderSessions(removed: (owner: HostedNativeProviderGrantOwner) => boolean): Promise<void> {
    const store = new HostedAgentStore(this.#options.store);
    for (const record of store.list()) if (record.owner.providerGrant && removed(record.owner.providerGrant)
      && (record.state === "closed" || record.state === "purging")) {
      await purgeHostedAgentStorage({ root: this.#options.root, store, key: record.key, leaseId: record.leaseId });
    }
  }
  async purgeClosedRelayedGuestSessions(authorityId: string, backendId: string): Promise<void> {
    const store = new HostedAgentStore(this.#options.store);
    for (const record of store.list()) if (record.owner.trust === "guest" && record.owner.authorityId === authorityId && record.owner.backendId === backendId
      && (record.state === "closed" || record.state === "purging")) await purgeHostedAgentStorage({ root: this.#options.root, store, key: record.key, leaseId: record.leaseId });
  }
  authenticate(context: HandlerContext): HostedAgentPrincipal | Promise<HostedAgentPrincipal> {
    if ((context.requestHeader.get("authorization") ?? "").startsWith("ProviderShareGuest ")) {
      if (!this.#options.authenticateGuest) throw new ConnectError("Provider sharing authorization is unavailable.", Code.Unauthenticated);
      return this.#options.authenticateGuest(context);
    }
    return this.#authenticateOwner(context);
  }
  /** Exact public Provider snapshot for an already remote-enabled native factory. */
  shareableProvider(backendId: string, providerId: string) {
    const grouped = this.#options.resolveSharedProvider?.(backendId, providerId);
    if (grouped) {
      const assertComputer = this.settings.captureComputer(), assertProvider = this.settings.captureProvider(backendId, providerId);
      const assertCurrent = () => { assertComputer(); assertProvider(); grouped.assertCurrent(); };
      assertCurrent();
      if (grouped.catalog.backendId !== backendId || grouped.catalog.providers.length !== 1 || grouped.catalog.providers[0]?.providerId !== providerId
        || !grouped.models.length || grouped.models.some(model => model.providerId !== providerId)) throw new HostedAgentHostError("UNAVAILABLE");
      return { ...grouped, assertCurrent };
    }
    const factory = this.#factories.get(backendId); if (!factory || factory.isolatedGuests?.() !== true || !factory.providerIds().includes(providerId)) throw new HostedAgentHostError("UNAVAILABLE");
    const assertComputer = this.settings.captureComputer(), assertProvider = this.settings.captureProvider(backendId, providerId);
    const assertCurrent = () => { assertComputer(); assertProvider(); if (factory.isolatedGuests?.() !== true || !factory.providerIds().includes(providerId)) throw new HostedAgentHostError("UNAVAILABLE"); };
    assertCurrent(); const models = factory.models().filter(model => model.providerId === providerId);
    if (!models.length) throw new HostedAgentHostError("UNAVAILABLE");
    const descriptor = factory.describe?.(), provider = descriptor?.providers?.find(item => item.providerId === providerId);
    const catalog = create(contract.HostedAgentBackendCatalogSchema, { backendId, instanceGeneration: BigInt(this.#options.store.getBackend(backendId).descriptor.instanceGeneration), displayName: factory.displayName ?? backendId, nativeAdapterKind: descriptor?.adapterKind ?? "", nodeId: this.#options.nodeId ?? "",
      version: factory.version?.() ?? "", capabilities: [...(factory.capabilities?.().values() ?? [])].map(toProtoCapability),
      providers: [{ providerId, displayName: providerId, accessKind: provider?.accessKind ?? "", accessProduct: provider?.accessProduct ?? "",
        remoteInvocationEnabled: true, connected: true, models: models.map(model => toProtoModelDescriptor(backendId, model)) }] });
    return { models, catalog, assertCurrent };
  }
  assertGuestSelection(principal: HostedAgentPrincipal, input: Pick<HostedAgentOpen, "backendId" | "providerId" | "modelId">): void {
    if (principal.trust !== "guest") { principal.assertCurrent(); return; }
    const grant = principal.providerGrant; if (!grant || grant.backendId !== input.backendId || grant.providerId !== input.providerId
      || !grant.modelIds.includes(input.modelId)) throw new HostedAgentHostError("ACCESS_DENIED");
    principal.assertCurrent(); grant.assertCurrent();
    const models = grant.groupMember ? this.#factories.get(input.backendId)?.models().filter(model => model.providerId === input.providerId) ?? []
      : this.shareableProvider(input.backendId, input.providerId).models;
    if (!models.some(model => model.modelId === input.modelId)) throw new HostedAgentHostError("UNAVAILABLE");
  }
  #authenticateOwner(context: HandlerContext): HostedAgentPrincipal {
    let connection: ReturnType<ConnectionManager["authenticate"]>;
    try { connection = this.#options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined); }
    catch { throw new ConnectError("Authentication is required.", Code.Unauthenticated); }
    return { id: `owner:${connection.id}`, deviceId: connection.deviceId, trust: "owner",
      assertCurrent: () => { this.#options.connections.fence(connection); } };
  }
  readonly #inferenceAccess = (principal: HostedAgentPrincipal, request: HostedNativeInferenceRequest): (() => void) => {
    const factory = this.#factories.get(request.backendId);
    if (!factory || !this.#options.inferNativeText || principal.trust === "guest" && factory.isolatedGuests?.() !== true) throw new HostedAgentHostError("UNAVAILABLE");
    const assertComputer = this.settings.captureComputer(), assertProvider = this.settings.captureProvider(request.backendId, request.providerId);
    return () => {
      principal.assertCurrent(); principal.providerGrant?.assertCurrent(); assertComputer(); assertProvider();
      const descriptor = this.#options.store.getBackend(request.backendId).descriptor;
      if (descriptor.instanceGeneration !== request.backendInstanceGeneration
        || !descriptor.models.some(model => model.providerId === request.providerId && model.modelId === request.modelId
          && (!request.images?.length || model.supportsImages))
        || !factory.models().some(model => model.providerId === request.providerId && model.modelId === request.modelId
          && (!request.images?.length || model.supportsImages))) throw new HostedAgentHostError("UNAVAILABLE");
      this.assertGuestSelection(principal, request);
    };
  };
  readonly #infer = async (principal: HostedAgentPrincipal, request: HostedNativeInferenceRequest, signal: AbortSignal): Promise<string> => {
    const assertAccess = this.#inferenceAccess(principal, request), infer = this.#options.inferNativeText!;
    const owner = new AbortController(), active = AbortSignal.any([owner.signal, signal]);
    const assertCurrent = () => {
      active.throwIfAborted(); assertAccess();
    };
    const assertModelAllowed = (providerId: string, modelId: string) => {
      if (providerId !== request.providerId || modelId !== request.modelId) throw new HostedAgentHostError("ACCESS_DENIED");
      assertCurrent();
    };
    assertCurrent();
    const timer = setInterval(() => { try { assertCurrent(); } catch (error) { owner.abort(error); } }, 100); timer.unref();
    try {
      const result = await infer(request.backendId, { system: request.system, user: request.user, providerId: request.providerId, modelId: request.modelId,
        backendInstanceGeneration: request.backendInstanceGeneration, timeoutMs: request.timeoutMs, signal: active, assertCurrent, assertModelAllowed,
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.images === undefined ? {} : { images: request.images.map(image => ({ data: Buffer.from(image.data, "base64"), mimeType: image.mimeType })) }) });
      assertCurrent(); return result;
    } finally { clearInterval(timer); owner.abort(); }
  };
  readonly #authorize: HostedAgentHostOptions["authorize"] = (principal, input) => {
    principal.assertCurrent(); const assertComputer = this.settings.captureComputer(), factory = this.#factories.get(input.backendId);
    if (!factory) throw new HostedAgentHostError("UNAVAILABLE");
    this.assertGuestSelection(principal, input);
    // An owner may change among its explicitly remote-enabled Providers. A
    // shared grant supplies only its selected Provider to a dedicated factory.
    const providerIds = principal.trust === "guest" ? [input.providerId] : factory.providerIds().filter(providerId => this.settings.providerEnabled(input.backendId, providerId));
    const permissions = new Map(providerIds.map(providerId => [providerId, this.settings.captureProvider(input.backendId, providerId)]));
    const assertModelAllowed = (providerId: string, modelId: string) => {
      if (principal.trust === "guest") this.assertGuestSelection(principal, { backendId: input.backendId, providerId, modelId });
      assertComputer(); const assertProvider = permissions.get(providerId); if (!assertProvider) throw new HostedAgentHostError("ACCESS_DENIED"); assertProvider();
      if (!factory.models().some(model => model.providerId === providerId && model.modelId === modelId)) throw new HostedAgentHostError("UNAVAILABLE");
    };
    assertModelAllowed(input.providerId, input.modelId);
    const modelIds = factory.models().filter(model => model.providerId === input.providerId).map(model => model.modelId);
    return { root: this.#options.root, store: new HostedAgentStore(this.#options.store), slots: this.slots, artifactCapacityBytes: this.#options.artifactCapacityBytes,
      modelIds, assertCurrent: () => { principal.assertCurrent(); assertComputer(); }, assertModelAllowed,
      createAdapter: creation => { principal.assertCurrent(); assertModelAllowed(creation.providerId, input.modelId);
        return factory.create({ ...creation, providerIds, assertModelAllowed }); } };
  };
}
