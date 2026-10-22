import type { BackendAdapter, BlobRef, CapabilityManifest, ProviderModel, HostedExecution } from "@joko/core";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { HostedAgentStore, type OperationalStore } from "@joko/store";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import type { ConnectionManager } from "./connection-manager.js";
import { HostedAgentHost, HostedAgentHostError, type HostedAgentHostOptions, type HostedAgentPrincipal } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentSettings } from "./hosted-agent-settings.js";
import type { HostedAgentConnectOptions } from "./hosted-agent-connect-service.js";
import { toProtoCapability, toProtoModelDescriptor } from "./proto-mapper.js";
import { HOSTED_AGENT_WIRE_FORMAT } from "./hosted-agent-wire.js";

export interface HostedAgentBackendFactory {
  readonly backendId: string;
  readonly displayName?: string;
  readonly providerIds: () => readonly string[];
  readonly providerDisplayName?: (providerId: string) => string;
  readonly capabilities?: () => CapabilityManifest;
  readonly version?: () => string;
  /** Current enabled, authenticated models on the actual native Provider node. */
  readonly models: () => readonly ProviderModel[];
  readonly create: (input: HostedAgentBackendCreation) => BackendAdapter | Promise<BackendAdapter>;
}
export interface HostedAgentBackendCreation {
  readonly home: string; readonly trust: "owner" | "guest"; readonly providerId: string;
  readonly providerIds: readonly string[]; readonly modelIds: readonly string[]; readonly signal: AbortSignal; readonly execution: HostedExecution;
  readonly nativeOwner: { readonly sessionId: string; readonly targetId: string; readonly generation: number; readonly backendInstanceGeneration: number };
  readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
  readonly assertModelAllowed: (providerId: string, modelId: string) => void;
}
export interface HostedAgentRuntimeOptions {
  readonly store: OperationalStore;
  readonly root: string;
  readonly artifactCapacityBytes: number;
  readonly connections: ConnectionManager;
  readonly factories: readonly HostedAgentBackendFactory[];
}

/** Composes native process ownership, the durable native journal and current
 * remote permissions. Factory credentials and networking stay on this node. */
export class HostedAgentRuntime {
  readonly settings: HostedAgentSettings;
  readonly slots: HostedAgentSessionSlots;
  readonly host: HostedAgentHost;
  readonly #factories: ReadonlyMap<string, HostedAgentBackendFactory>;
  readonly #options: HostedAgentRuntimeOptions;
  constructor(options: HostedAgentRuntimeOptions) {
    this.#options = options; this.settings = new HostedAgentSettings(options.store); this.slots = new HostedAgentSessionSlots(() => this.settings.limits());
    this.#factories = new Map(options.factories.map(factory => [factory.backendId, factory]));
    if (this.#factories.size !== options.factories.length) throw new Error("Hosted Agent Backend factories conflict.");
    this.host = new HostedAgentHost({ authorize: this.#authorize });
  }
  connectOptions(): HostedAgentConnectOptions {
    return { host: this.host, authenticate: context => this.#authenticateOwner(context), catalog: principal => {
      principal.assertCurrent();
      // A future shared catalog must be derived from its original issuer's
      // grant. An owner catalog must never be borrowed by a task-sharing guest.
      if (principal.trust !== "owner") throw new HostedAgentHostError("ACCESS_DENIED");
      const snapshot = this.settings.snapshot();
      return create(contract.GetHostedAgentCatalogResponseSchema, { format: HOSTED_AGENT_WIRE_FORMAT,
        remoteControlEnabled: snapshot.value.remoteControlEnabled,
        backends: [...this.#factories.values()].map(factory => {
          const models = factory.models();
          return { backendId: factory.backendId, displayName: factory.displayName ?? factory.backendId,
            capabilities: [...(factory.capabilities?.().values() ?? [])].map(toProtoCapability), version: factory.version?.() ?? "",
            providers: factory.providerIds().map(providerId => {
              const current = models.filter(model => model.providerId === providerId);
              return { providerId, displayName: factory.providerDisplayName?.(providerId) ?? providerId,
                remoteInvocationEnabled: this.settings.providerEnabled(factory.backendId, providerId), connected: current.length > 0,
                models: current.map(model => toProtoModelDescriptor(factory.backendId, model)) };
            }) };
        }) });
    },
      management: { settings: this.settings, slots: this.slots, assertProviderExists: (backendId, providerId) => {
        if (!this.#factories.get(backendId)?.providerIds().includes(providerId)) throw new HostedAgentHostError("UNAVAILABLE");
      }, onChanged: () => this.host.sweep() } };
  }
  close(): Promise<void> { return this.host.dispose(); }
  #authenticateOwner(context: HandlerContext): HostedAgentPrincipal {
    let connection: ReturnType<ConnectionManager["authenticate"]>;
    try { connection = this.#options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined); }
    catch { throw new ConnectError("Authentication is required.", Code.Unauthenticated); }
    return { id: `owner:${connection.id}`, deviceId: connection.deviceId, trust: "owner",
      assertCurrent: () => { this.#options.connections.fence(connection); } };
  }
  readonly #authorize: HostedAgentHostOptions["authorize"] = (principal, input) => {
    principal.assertCurrent(); const assertComputer = this.settings.captureComputer(), factory = this.#factories.get(input.backendId);
    if (!factory) throw new HostedAgentHostError("UNAVAILABLE");
    // An owner may change among its explicitly remote-enabled Providers. A
    // shared grant supplies only its selected Provider to a dedicated factory.
    const providerIds = principal.trust === "guest" ? [input.providerId] : factory.providerIds().filter(providerId => this.settings.providerEnabled(input.backendId, providerId));
    const permissions = new Map(providerIds.map(providerId => [providerId, this.settings.captureProvider(input.backendId, providerId)]));
    const assertModelAllowed = (providerId: string, modelId: string) => {
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
