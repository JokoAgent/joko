import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { piProviderModel } from "@joko/adapter-pi";
import type {
  BackendProviderDescriptor, ManagedProviderOperationLease, ManagedProviderRouteBinding,
  ManagedProviderRouteOwner, ManagedProviderRuntimePort, ManagedProviderSmartRoutingBinding,
  ManagedProviderSmartRoutingRoute, ProviderRuntimeProtocol, ProviderRuntimeSupport
} from "@joko/core";
import type { ProviderCatalogManager, ProviderInferenceRoute } from "./credential-manager.js";

const BODY_LIMIT = 32 * 1024 * 1024;
const ENVIRONMENT_NAME = "JOKO_PROVIDER_PROXY_TOKEN";
const MAXIMUM_BINDINGS = 4_096;
const MAXIMUM_SUBTASK_ROUTES = 256;
const MAXIMUM_SMART_DESCENDANTS = 512;
const MAXIMUM_RETIRED_SMART_DESCENDANTS = 4_096;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const SMART_TOKEN_HEADER = "x-joko-provider-proxy-token";

interface RuntimeOwner {
  readonly backendId: string;
  readonly generation: number;
  readonly token: string;
  readonly assertCurrent: () => void;
  retired: boolean;
}

interface ActiveOperation {
  readonly operationId: string;
  readonly route: ProviderInferenceRoute;
  readonly abort: AbortController;
  readonly assertCurrent: () => void;
  readonly release: () => void;
  readonly subtasks: Map<string, ActiveSubtaskRoute>;
}

interface ActiveSubtaskRoute {
  readonly requestId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly route: ProviderInferenceRoute;
  readonly abort: AbortController;
  readonly assertCurrent: () => void;
  readonly release: () => void;
}

interface BindingState {
  readonly id: string;
  readonly runtime: RuntimeOwner;
  readonly owner: ManagedProviderRouteOwner;
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly protocol: ProviderRuntimeProtocol;
  active?: ActiveOperation;
}

interface ActiveSmartOperation {
  readonly operationId: string;
  readonly abort: AbortController;
  readonly assertCurrent: () => void;
  readonly release: () => void;
  readonly descendants: Map<string, string>;
  readonly descendantRoutes: Map<string, ActiveSmartThreadRoute>;
  readonly terminalDescendants: Set<string>;
}

interface ActiveSmartThreadRoute {
  readonly kind: "collab_spawn" | "internal";
  readonly providerId: string;
  readonly modelId: string;
  readonly revision?: string;
  readonly native: boolean;
}

interface SmartBindingState {
  readonly id: string;
  readonly runtime: RuntimeOwner;
  readonly owner: ManagedProviderRouteOwner;
  readonly nativeProviderId: string;
  rootProviderId?: string;
  rootModelId?: string;
  rootRevision?: string;
  readonly revision: string;
  readonly routes: ReadonlyMap<string, ManagedProviderSmartRoutingRoute>;
  readonly retiredDescendants: Set<string>;
  lineageExhausted: boolean;
  rootThreadId?: string;
  active?: ActiveSmartOperation;
}

/** Node-private native HTTP transport. Public RPC, Store and native config never receive its token. */
export class ManagedProviderProxy {
  readonly #server: Server;
  readonly #providers: ProviderCatalogManager;
  readonly #fetch: typeof fetch;
  readonly #assertOwner: (owner: ManagedProviderRouteOwner) => void;
  readonly #bindings = new Map<string, BindingState>();
  readonly #smartBindings = new Map<string, SmartBindingState>();
  #origin = "";
  #closed = false;

  constructor(options: {
    readonly providers: ProviderCatalogManager;
    readonly assertOwner: (owner: ManagedProviderRouteOwner) => void;
    readonly fetch?: typeof fetch;
  }) {
    this.#providers = options.providers;
    this.#assertOwner = options.assertOwner;
    this.#fetch = options.fetch ?? fetch;
    this.#server = createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
      void this.#handle(request, response).catch(() => { if (!response.destroyed) response.destroy(); });
    });
    this.#server.on("upgrade", (_request, socket) => socket.destroy());
    this.#server.requestTimeout = 30_000;
    this.#server.headersTimeout = 15_000;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Managed Provider proxy is closed.");
    if (this.#origin !== "") return;
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => { this.#server.off("error", reject); resolve(); });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("Managed Provider proxy has no loopback address.");
    this.#origin = `http://127.0.0.1:${address.port}`;
  }

  createRuntime(input: {
    readonly backendId: string;
    readonly generation: number;
    readonly support: ProviderRuntimeSupport;
    readonly assertCurrent: () => void;
  }): ManagedProviderRuntimePort {
    if (this.#origin === "" || this.#closed) throw new Error("Managed Provider proxy is not running.");
    const runtime: RuntimeOwner = { ...input, token: randomBytes(32).toString("base64url"), retired: false };
    const hasProvider = (providerId: string) => this.#providers.hasManagedProvider(input.backendId, providerId);
    const supported = (protocol: string | undefined): protocol is ProviderRuntimeProtocol =>
      protocol !== undefined && input.support.protocols.includes(protocol as ProviderRuntimeProtocol);
    return {
      support: input.support,
      environment: Object.freeze({ [ENVIRONMENT_NAME]: runtime.token }),
      secretEnvironmentNames: [ENVIRONMENT_NAME],
      dispose: () => {
        runtime.retired = true;
        for (const [id, binding] of this.#bindings) if (binding.runtime === runtime) {
          binding.active?.release(); this.#bindings.delete(id);
        }
        for (const [id, binding] of this.#smartBindings) if (binding.runtime === runtime) {
          binding.active?.release(); this.#smartBindings.delete(id);
        }
      },
      hasProvider,
      getThinkingLevelMap: (providerId, modelId) => {
        const model = this.#providers.listManaged(input.backendId).find((entry) => entry.provider.id === providerId)?.provider.models.find((candidate) => candidate.id === modelId);
        if (model === undefined) throw unavailable();
        return Object.freeze({ ...model.thinkingLevelMap });
      },
      listModels: () => this.#providers.listManaged(input.backendId).flatMap((entry) => {
        if (!entry.enabled || !supported(entry.provider.api)) return [];
        return entry.provider.models.filter((model) => supported(model.api ?? entry.provider.api)
          && this.#providers.hasInferenceModel(input.backendId, entry.provider.id, model.id))
          .map((model) => ({ ...piProviderModel(entry.provider, model), contextWindow: model.contextWindow ?? 0, maxOutputTokens: model.maxTokens ?? 0 }));
      }),
      listSmartRoutingCandidates: () => this.#providers.listManaged(input.backendId).flatMap((entry) => {
        if (!entry.enabled || !supported(entry.provider.api)
          || entry.authenticationState !== "authenticated" && entry.authenticationState !== "not_required") return [];
        return entry.provider.models.flatMap((model) => {
          const protocol = model.api ?? entry.provider.api;
          const identity = protocol === undefined
            ? undefined
            : this.#providers.describeInferenceRoute(input.backendId, entry.provider.id, model.id);
          if (!supported(protocol) || identity === undefined) return [];
          return [{
            providerId: entry.provider.id,
            model: {
              ...piProviderModel(entry.provider, model),
              contextWindow: model.contextWindow ?? 0,
              maxOutputTokens: model.maxTokens ?? 0
            },
            protocol,
            revision: identity.generationId
          }];
        });
      }),
      listProviders: () => this.#providers.listManaged(input.backendId).filter((entry) => supported(entry.provider.api)).map((entry): BackendProviderDescriptor => ({
        providerId: entry.provider.id, displayName: entry.displayName,
        accessKind: entry.provider.keyless ? "managed" : "apiKey", api: entry.provider.api!,
        authenticationState: entry.authenticationState, loginMethods: [], supportsLogin: false, supportsLogout: false,
        supportsRefresh: false, supportsModelRefresh: entry.supportsModelRefresh === true, providesModelPricing: true
      })),
      prepare: async (owner) => {
        // Session creation uses a provisional context. This template grants no HTTP
        // authority; the durable Session is required at activation and every request.
        if (runtime.retired) throw unavailable();
        runtime.assertCurrent();
        if (owner.backendId !== runtime.backendId || owner.backendInstanceGeneration !== runtime.generation) throw unavailable();
        const entry = this.#providers.get(owner.backendId, owner.providerId);
        const model = entry.provider.models.find((candidate) => candidate.id === owner.modelId);
        const protocol = model?.api ?? entry.provider.api;
        const identity = this.#providers.describeInferenceRoute(owner.backendId, owner.providerId, owner.modelId);
        if (!hasProvider(owner.providerId) || model === undefined || !supported(protocol) || identity === undefined) throw unavailable();
        if (this.#bindings.size + this.#smartBindings.size >= MAXIMUM_BINDINGS) {
          throw new Error("Managed Provider route capacity is exhausted.");
        }
        const state: BindingState = { id: randomUUID(), runtime, owner: { ...owner }, providerId: owner.providerId,
          modelId: owner.modelId, revision: identity.generationId, protocol };
        this.#bindings.set(state.id, state);
        const assertCurrent = () => {
          this.#assertBinding(state);
          const current = this.#providers.describeInferenceRoute(owner.backendId, owner.providerId, owner.modelId);
          if (current?.generationId !== state.revision) throw unavailable();
        };
        const binding: ManagedProviderRouteBinding = {
          providerId: owner.providerId, model: { ...piProviderModel(entry.provider, model), contextWindow: model.contextWindow ?? 0, maxOutputTokens: model.maxTokens ?? 0 }, protocol,
          revision: state.revision, baseUrl: `${this.#origin}/managed/${state.id}`, apiKeyEnvironment: ENVIRONMENT_NAME,
          thinkingLevelMap: Object.freeze({ ...model.thinkingLevelMap }),
          assertCurrent,
          activate: async (operation) => {
            assertCurrent();
            this.#assertOwner(state.owner);
            operation.assertCurrent();
            if (operation.signal.aborted || operation.operationId.trim() === "" || state.active !== undefined) throw unavailable();
            const route = this.#providers.resolveInferenceRoute(owner.backendId, owner.providerId, owner.modelId);
            if (route?.generationId !== state.revision) throw unavailable();
            const abort = new AbortController();
            const release = () => {
              operation.signal.removeEventListener("abort", release);
              if (state.active === active) state.active = undefined;
              for (const subtask of active.subtasks.values()) subtask.release();
              abort.abort();
            };
            const active: ActiveOperation = { operationId: operation.operationId, route, abort,
              assertCurrent: operation.assertCurrent, release, subtasks: new Map() };
            state.active = active;
            operation.signal.addEventListener("abort", release, { once: true });
            if (operation.signal.aborted) release();
            return { release } satisfies ManagedProviderOperationLease;
          },
          authorizeSubtask: async (subtask) => {
            assertCurrent();
            this.#assertOwner(state.owner);
            const active = state.active;
            if (active === undefined || active.operationId !== subtask.operationId || active.abort.signal.aborted
              || subtask.signal.aborted || subtask.requestId.trim() === "" || subtask.requestId.length > 512
              || subtask.modelId.trim() === "" || subtask.modelId.length > 512
              || active.subtasks.has(subtask.requestId) || active.subtasks.size >= MAXIMUM_SUBTASK_ROUTES) {
              throw unavailable();
            }
            active.assertCurrent();
            subtask.assertCurrent();
            const entry = this.#providers.get(state.owner.backendId, state.providerId);
            const model = entry.provider.models.find((candidate) => candidate.id === subtask.modelId);
            const protocol = model?.api ?? entry.provider.api;
            const identity = this.#providers.describeInferenceRoute(state.owner.backendId, state.providerId, subtask.modelId);
            const route = this.#providers.resolveInferenceRoute(state.owner.backendId, state.providerId, subtask.modelId);
            if (model === undefined || protocol !== state.protocol || identity === undefined || route === undefined
              || route.providerId !== state.providerId || route.modelId !== subtask.modelId
              || route.api !== state.protocol || route.generationId !== identity.generationId) throw unavailable();
            const abort = new AbortController();
            let released = false;
            const release = () => {
              if (released) return;
              released = true;
              subtask.signal.removeEventListener("abort", release);
              if (active.subtasks.get(subtask.requestId) === granted) active.subtasks.delete(subtask.requestId);
              abort.abort();
            };
            const granted: ActiveSubtaskRoute = {
              requestId: subtask.requestId,
              modelId: subtask.modelId,
              revision: identity.generationId,
              route,
              abort,
              assertCurrent: subtask.assertCurrent,
              release
            };
            active.subtasks.set(subtask.requestId, granted);
            subtask.signal.addEventListener("abort", release, { once: true });
            if (subtask.signal.aborted) release();
            return {
              model: {
                ...piProviderModel(entry.provider, model),
                contextWindow: model.contextWindow ?? 0,
                maxOutputTokens: model.maxTokens ?? 0
              },
              thinkingLevelMap: Object.freeze({ ...model.thinkingLevelMap }),
              release
            };
          },
          dispose: () => { state.active?.release(); this.#bindings.delete(state.id); }
        };
        return binding;
      },
      prepareSmartRouting: async (owner) => {
        if (runtime.retired || owner.backendId !== runtime.backendId
          || owner.backendInstanceGeneration !== runtime.generation
          || !validIdentity(owner.nativeProviderId, 128)
          || ((owner.rootProviderId === undefined) !== (owner.rootModelId === undefined))
          || (owner.rootProviderId !== undefined && !validIdentity(owner.rootProviderId, 128))
          || (owner.rootModelId !== undefined && !validIdentity(owner.rootModelId, 512))
          || !validIdentity(owner.revision, 512)
          || owner.routes.length === 0
          || owner.routes.length > MAXIMUM_SUBTASK_ROUTES
          || this.#bindings.size + this.#smartBindings.size >= MAXIMUM_BINDINGS) throw unavailable();
        runtime.assertCurrent();
        const routes = new Map<string, ManagedProviderSmartRoutingRoute>();
        for (const route of owner.routes) {
          if (!validIdentity(route.providerId, 128) || !validIdentity(route.modelId, 512)
            || !validIdentity(route.revision, 512) || routes.has(route.modelId)
            || route.native !== (route.providerId === owner.nativeProviderId)) throw unavailable();
          if (!route.native) {
            const identity = this.#providers.describeInferenceRoute(owner.backendId, route.providerId, route.modelId);
            const resolved = this.#providers.resolveInferenceRoute(owner.backendId, route.providerId, route.modelId);
            if (identity?.generationId !== route.revision || resolved?.generationId !== route.revision
              || resolved.api !== "openai-responses") throw unavailable();
          }
          routes.set(route.modelId, { ...route });
        }
        let rootRevision: string | undefined;
        if (owner.rootProviderId !== undefined && owner.rootProviderId !== owner.nativeProviderId) {
          const rootModelId = owner.rootModelId;
          if (rootModelId === undefined) throw unavailable();
          const identity = this.#providers.describeInferenceRoute(owner.backendId, owner.rootProviderId, rootModelId);
          const route = this.#providers.resolveInferenceRoute(owner.backendId, owner.rootProviderId, rootModelId);
          if (identity === undefined || route?.generationId !== identity.generationId || route.api !== "openai-responses") {
            throw unavailable();
          }
          rootRevision = identity.generationId;
        }
        const state: SmartBindingState = {
          id: randomUUID(),
          runtime,
          owner: {
            backendId: owner.backendId,
            backendInstanceGeneration: owner.backendInstanceGeneration,
            targetId: owner.targetId,
            sessionId: owner.sessionId,
            sessionGeneration: owner.sessionGeneration
          },
          nativeProviderId: owner.nativeProviderId,
          ...(owner.rootProviderId === undefined ? {} : { rootProviderId: owner.rootProviderId }),
          ...(owner.rootModelId === undefined ? {} : { rootModelId: owner.rootModelId }),
          ...(rootRevision === undefined ? {} : { rootRevision }),
          revision: owner.revision,
          routes,
          retiredDescendants: new Set(),
          lineageExhausted: false
        };
        this.#smartBindings.set(state.id, state);
        const assertCurrent = () => this.#assertSmartBinding(state);
        const binding: ManagedProviderSmartRoutingBinding = {
          modelProviderId: `joko-smart-${state.id.replace(/-/gu, "")}`,
          baseUrl: `${this.#origin}/smart/${state.id}`,
          proxyTokenEnvironment: ENVIRONMENT_NAME,
          revision: state.revision,
          routes: [...state.routes.values()].map((route) => ({ ...route })),
          assertCurrent,
          bindRoot: ({ threadId, providerId, modelId }) => {
            assertCurrent();
            if (!validIdentity(threadId, 512) || !validIdentity(providerId, 128) || !validIdentity(modelId, 512)
              || (state.rootThreadId !== undefined && state.rootThreadId !== threadId)
              || (state.rootProviderId !== undefined && state.rootProviderId !== providerId)
              || (state.rootModelId !== undefined && state.rootModelId !== modelId)) throw unavailable();
            if (providerId !== state.nativeProviderId) {
              const identity = this.#providers.describeInferenceRoute(state.owner.backendId, providerId, modelId);
              const route = this.#providers.resolveInferenceRoute(state.owner.backendId, providerId, modelId);
              if (identity === undefined || route?.generationId !== identity.generationId || route.api !== "openai-responses") throw unavailable();
              state.rootRevision = identity.generationId;
            } else {
              state.rootRevision = undefined;
            }
            state.rootProviderId = providerId;
            state.rootModelId = modelId;
            state.rootThreadId = threadId;
          },
          registerDescendant: (childThreadId, parentThreadId) => {
            assertCurrent();
            const active = state.active;
            // Historical projection may be installed while no user operation
            // owns Provider authority. It remains display-only; the first live
            // collab_spawn request can register under the active lease.
            if (active !== undefined) this.#registerSmartDescendant(state, active, childThreadId, parentThreadId);
          },
          completeDescendant: (threadId) => {
            // Completion only removes authority. Keep it best-effort even when
            // a concurrent credential/catalog revision has already fenced
            // further dispatches through assertCurrent().
            if (!validIdentity(threadId, 512) || this.#smartBindings.get(state.id) !== state) return;
            const active = state.active;
            if (active?.descendants.has(threadId) === true) active.terminalDescendants.add(threadId);
          },
          activate: async (operation) => {
            assertCurrent();
            this.#assertOwner(state.owner);
            operation.assertCurrent();
            if (operation.signal.aborted || !validIdentity(operation.operationId, 512)
              || state.rootThreadId === undefined || state.rootProviderId === undefined
              || state.rootModelId === undefined || state.active !== undefined) throw unavailable();
            const abort = new AbortController();
            const release = () => {
              operation.signal.removeEventListener("abort", release);
              if (state.active === active) {
                state.active = undefined;
                for (const threadId of active.descendants.keys()) {
                  if (state.retiredDescendants.size >= MAXIMUM_RETIRED_SMART_DESCENDANTS) {
                    state.lineageExhausted = true;
                    break;
                  }
                  state.retiredDescendants.add(threadId);
                }
              }
              abort.abort();
            };
            const active: ActiveSmartOperation = {
              operationId: operation.operationId,
              abort,
              assertCurrent: operation.assertCurrent,
              release,
              descendants: new Map(),
              descendantRoutes: new Map(),
              terminalDescendants: new Set()
            };
            state.active = active;
            operation.signal.addEventListener("abort", release, { once: true });
            if (operation.signal.aborted) release();
            return { release };
          },
          dispose: () => {
            state.active?.release();
            this.#smartBindings.delete(state.id);
          }
        };
        return binding;
      }
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const binding of this.#bindings.values()) binding.active?.release();
    this.#bindings.clear();
    for (const binding of this.#smartBindings.values()) binding.active?.release();
    this.#smartBindings.clear();
    this.#server.closeAllConnections();
    if (this.#server.listening) await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #assertBinding(state: BindingState): void {
    if (this.#closed || state.runtime.retired || this.#bindings.get(state.id) !== state) throw unavailable();
    state.runtime.assertCurrent();
  }

  #assertOperation(state: BindingState, operation: ActiveOperation): void {
    this.#assertBinding(state);
    this.#assertOwner(state.owner);
    if (state.active !== operation || operation.abort.signal.aborted || operation.route.generationId !== state.revision
      || operation.route.backendId !== state.owner.backendId || operation.route.providerId !== state.providerId
      || operation.route.modelId !== state.modelId) throw unavailable();
    operation.assertCurrent();
  }

  #assertSubtask(state: BindingState, operation: ActiveOperation, subtask: ActiveSubtaskRoute): void {
    this.#assertOperation(state, operation);
    if (operation.subtasks.get(subtask.requestId) !== subtask || subtask.abort.signal.aborted
      || subtask.route.generationId !== subtask.revision || subtask.route.backendId !== state.owner.backendId
      || subtask.route.providerId !== state.providerId || subtask.route.modelId !== subtask.modelId
      || subtask.route.api !== state.protocol) throw unavailable();
    subtask.assertCurrent();
  }

  #assertSmartBinding(state: SmartBindingState): void {
    if (this.#closed || state.runtime.retired || state.lineageExhausted
      || this.#smartBindings.get(state.id) !== state) throw unavailable();
    state.runtime.assertCurrent();
    for (const route of state.routes.values()) {
      if (route.native) continue;
      if (this.#providers.describeInferenceRoute(state.owner.backendId, route.providerId, route.modelId)?.generationId !== route.revision) {
        throw unavailable();
      }
    }
    if (state.rootRevision !== undefined) {
      if (state.rootProviderId === undefined || state.rootModelId === undefined
        || this.#providers.describeInferenceRoute(state.owner.backendId, state.rootProviderId, state.rootModelId)?.generationId !== state.rootRevision) {
        throw unavailable();
      }
    }
  }

  #assertSmartOperation(state: SmartBindingState, operation: ActiveSmartOperation): void {
    this.#assertSmartBinding(state);
    this.#assertOwner(state.owner);
    if (state.active !== operation || operation.abort.signal.aborted || state.rootThreadId === undefined) throw unavailable();
    operation.assertCurrent();
  }

  #registerSmartDescendant(
    state: SmartBindingState,
    operation: ActiveSmartOperation,
    childThreadId: string,
    parentThreadId: string
  ): void {
    if (!validIdentity(childThreadId, 512) || !validIdentity(parentThreadId, 512)
      || childThreadId === state.rootThreadId || state.rootThreadId === undefined
      || state.active !== operation || state.lineageExhausted
      || state.retiredDescendants.has(childThreadId)) throw unavailable();
    const existing = operation.descendants.get(childThreadId);
    if (existing !== undefined) {
      if (existing !== parentThreadId) throw unavailable();
      return;
    }
    if (operation.terminalDescendants.has(childThreadId)
      || (parentThreadId !== state.rootThreadId && !operation.descendants.has(parentThreadId))
      || operation.terminalDescendants.has(parentThreadId)) throw unavailable();
    if (operation.descendants.size >= MAXIMUM_SMART_DESCENDANTS) throw unavailable();
    let cursor = parentThreadId;
    for (let depth = 0; depth <= MAXIMUM_SMART_DESCENDANTS; depth += 1) {
      if (cursor === childThreadId) throw unavailable();
      if (cursor === state.rootThreadId) break;
      const parent = operation.descendants.get(cursor);
      if (parent === undefined) throw unavailable();
      cursor = parent;
    }
    operation.descendants.set(childThreadId, parentThreadId);
  }

  #smartRouteForRequest(
    state: SmartBindingState,
    operation: ActiveSmartOperation,
    request: IncomingMessage,
    requestedModel: string
  ): { readonly route?: ProviderInferenceRoute; readonly native: boolean } {
    if (state.rootProviderId === undefined || state.rootModelId === undefined) throw unavailable();
    const threadId = singleHeader(request, "thread-id");
    const parentThreadId = singleHeader(request, "x-codex-parent-thread-id");
    const subagent = singleHeader(request, "x-openai-subagent").toLowerCase();
    if (!validIdentity(threadId, 512)) throw unavailable();
    let selected: ActiveSmartThreadRoute;
    if (subagent === "collab_spawn") {
      if (!validIdentity(parentThreadId, 512)) throw unavailable();
      this.#registerSmartDescendant(state, operation, threadId, parentThreadId);
      if (operation.terminalDescendants.has(threadId)) throw unavailable();
      let proposed: ActiveSmartThreadRoute;
      if (requestedModel === state.rootModelId) {
        proposed = { ...smartRootRoute(state), kind: "collab_spawn" };
      } else {
        const candidate = state.routes.get(requestedModel);
        if (candidate === undefined) throw unavailable();
        proposed = { kind: "collab_spawn", ...candidate };
      }
      const existing = operation.descendantRoutes.get(threadId);
      if (existing === undefined) operation.descendantRoutes.set(threadId, proposed);
      else if (!sameSmartThreadRoute(existing, proposed)) throw unavailable();
      selected = existing ?? proposed;
    } else if (subagent !== "") {
      // Guardian/reviewer-like internal descendants belong to the root
      // session route. They never gain access to the cross-Provider smart
      // candidate set selected by a collab_spawn parent.
      if (!validIdentity(parentThreadId, 512)) throw unavailable();
      this.#registerSmartDescendant(state, operation, threadId, parentThreadId);
      if (operation.terminalDescendants.has(threadId)) throw unavailable();
      const root = smartRootRoute(state);
      if (requestedModel !== root.modelId) throw unavailable();
      const proposed: ActiveSmartThreadRoute = { ...root, kind: "internal" };
      const existing = operation.descendantRoutes.get(threadId);
      if (existing === undefined) operation.descendantRoutes.set(threadId, proposed);
      else if (!sameSmartThreadRoute(existing, proposed)) throw unavailable();
      selected = existing ?? proposed;
    } else if (parentThreadId !== "" || threadId !== state.rootThreadId || requestedModel !== state.rootModelId) {
      throw unavailable();
    } else {
      selected = smartRootRoute(state);
    }
    if (selected.native) {
      if (selected.providerId !== state.nativeProviderId) throw unavailable();
      return { native: true };
    }
    const route = this.#providers.resolveInferenceRoute(state.owner.backendId, selected.providerId, selected.modelId);
    if (selected.revision === undefined || route?.generationId !== selected.revision
      || route.api !== "openai-responses") throw unavailable();
    return { route, native: false };
  }

  async #handleSmart(request: IncomingMessage, response: ServerResponse, state: SmartBindingState, path: string): Promise<void> {
    if (request.method !== "POST" || !authorizedSmart(request, state.runtime.token)) return fail(response, 403);
    const operation = state.active;
    if (operation === undefined || request.headers["content-encoding"] !== undefined) return fail(response, 409);
    const suffix = requestSuffix("openai-responses", path);
    if (suffix === undefined) return fail(response, 404);
    const abort = new AbortController();
    const close = () => abort.abort();
    request.once("aborted", close);
    response.once("close", close);
    const timeout = setTimeout(close, REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([operation.abort.signal, abort.signal]);
    try {
      this.#assertSmartOperation(state, operation);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        if (signal.aborted) throw unavailable();
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > BODY_LIMIT) { fail(response, 413); return; }
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { fail(response, 400); return; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || !validIdentity((parsed as { readonly model?: unknown }).model, 512)) { fail(response, 400); return; }
      const requestedModel = (parsed as { readonly model: string }).model;
      const selected = this.#smartRouteForRequest(state, operation, request, requestedModel);
      this.#assertSmartOperation(state, operation);
      const nativeAuthorization = selected.native ? singleHeader(request, "authorization") : "";
      if (selected.native && (!validSecretHeader(nativeAuthorization) || selected.route !== undefined)) throw unavailable();
      const accountId = selected.native ? singleHeader(request, "chatgpt-account-id") : "";
      const fedramp = selected.native ? singleHeader(request, "x-openai-fedramp") : "";
      if (fedramp !== "" && (fedramp !== "true" || accountId === "")) throw unavailable();
      const baseUrl = selected.native
        ? accountId === "" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex"
        : selected.route!.baseUrl;
      const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
      const endpoint = selected.route?.requestPath === undefined
        ? new URL(path.slice(1), base)
        : new URL(`${selected.route.requestPath.replace(/\/$/u, "")}${suffix}`, base.origin);
      if (endpoint.origin !== base.origin) throw unavailable();
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream, application/json" });
      for (const name of [
        "anthropic-version", "anthropic-beta", "openai-beta", "x-codex-turn-metadata", "session_id",
        "thread-id", "x-client-request-id", "x-openai-subagent", "x-codex-parent-thread-id"
      ]) {
        const value = singleHeader(request, name);
        if (value !== "") headers.set(name, value);
      }
      if (selected.native) {
        headers.set("authorization", nativeAuthorization);
        if (accountId !== "") headers.set("chatgpt-account-id", accountId);
        if (fedramp !== "") headers.set("x-openai-fedramp", fedramp);
      } else {
        for (const [name, value] of Object.entries(selected.route!.headers)) {
          if (name.toLowerCase() !== SMART_TOKEN_HEADER) headers.set(name, value);
        }
        if (selected.route!.authorization !== undefined) headers.set("authorization", selected.route!.authorization);
      }
      this.#assertSmartOperation(state, operation);
      const upstream = await this.#fetch(endpoint, { method: "POST", headers, body, redirect: "manual", signal });
      this.#assertSmartOperation(state, operation);
      if (!upstream.ok || upstream.body === null) {
        await upstream.body?.cancel();
        fail(response, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
        return;
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store"
      });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          this.#assertSmartOperation(state, operation);
          if (chunk.done) break;
          if (!response.write(chunk.value)) await once(response, "drain", { signal });
        }
      } finally { reader.releaseLock(); }
      response.end();
    } catch {
      if (!response.headersSent) fail(response, signal.aborted ? 499 : 502);
      else response.destroy();
    } finally {
      abort.abort();
      clearTimeout(timeout);
      request.off("aborted", close);
      response.off("close", close);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const smartMatch = /^\/smart\/([a-f0-9-]{36})(\/[^?#]*)$/u.exec(request.url ?? "");
    const smartState = smartMatch === null ? undefined : this.#smartBindings.get(smartMatch[1]!);
    if (smartState !== undefined) {
      await this.#handleSmart(request, response, smartState, smartMatch![2]!);
      return;
    }
    const match = /^\/managed\/([a-f0-9-]{36})(\/[^?#]*)$/u.exec(request.url ?? "");
    const state = match === null ? undefined : this.#bindings.get(match[1]!);
    if (request.method !== "POST" || state === undefined || !authorized(request, state.runtime.token)) return fail(response, 403);
    const operation = state.active;
    if (operation === undefined || request.headers["content-encoding"] !== undefined) return fail(response, 409);
    const suffix = requestSuffix(state.protocol, match![2]!);
    if (suffix === undefined) return fail(response, 404);
    const abort = new AbortController();
    const close = () => abort.abort();
    request.once("aborted", close);
    response.once("close", close);
    const timeout = setTimeout(close, REQUEST_TIMEOUT_MS);
    let signal = AbortSignal.any([operation.abort.signal, abort.signal]);
    try {
      this.#assertOperation(state, operation);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        if (signal.aborted) throw unavailable();
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > BODY_LIMIT) { fail(response, 413); return; }
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { fail(response, 400); return; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || typeof (parsed as { model?: unknown }).model !== "string") { fail(response, 400); return; }
      const requestedModel = (parsed as { model: string }).model;
      let route = operation.route;
      let subtask: ActiveSubtaskRoute | undefined;
      if (requestedModel !== state.modelId) {
        subtask = [...operation.subtasks.values()].find((candidate) => candidate.modelId === requestedModel && !candidate.abort.signal.aborted);
        if (subtask === undefined) { fail(response, 400); return; }
        this.#assertSubtask(state, operation, subtask);
        route = subtask.route;
        signal = AbortSignal.any([operation.abort.signal, subtask.abort.signal, abort.signal]);
      }
      const base = new URL(route.baseUrl.endsWith("/") ? route.baseUrl : `${route.baseUrl}/`);
      const endpoint = route.requestPath === undefined
        ? new URL(match![2]!.slice(1), base)
        : new URL(`${route.requestPath.replace(/\/$/u, "")}${suffix}`, base.origin);
      if (endpoint.origin !== base.origin) throw unavailable();
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream, application/json" });
      for (const name of ["anthropic-version", "anthropic-beta", "openai-beta", "x-codex-turn-metadata", "session_id"]) {
        const value = request.headers[name]; if (typeof value === "string") headers.set(name, value);
      }
      for (const [name, value] of Object.entries(route.headers)) {
        if (name.toLowerCase() !== SMART_TOKEN_HEADER) headers.set(name, value);
      }
      if (route.authorization !== undefined) headers.set("authorization", route.authorization);
      if (subtask === undefined) this.#assertOperation(state, operation);
      else this.#assertSubtask(state, operation, subtask);
      const upstream = await this.#fetch(endpoint, { method: "POST", headers, body, redirect: "manual", signal });
      if (subtask === undefined) this.#assertOperation(state, operation);
      else this.#assertSubtask(state, operation, subtask);
      if (!upstream.ok || upstream.body === null) {
        await upstream.body?.cancel();
        fail(response, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
        return;
      }
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (subtask === undefined) this.#assertOperation(state, operation);
          else this.#assertSubtask(state, operation, subtask);
          if (chunk.done) break;
          if (!response.write(chunk.value)) await once(response, "drain", { signal });
        }
      } finally { reader.releaseLock(); }
      response.end();
    } catch {
      if (!response.headersSent) fail(response, signal.aborted ? 499 : 502);
      else response.destroy();
    } finally {
      abort.abort();
      clearTimeout(timeout);
      request.off("aborted", close);
      response.off("close", close);
    }
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  const apiKey = request.headers["x-api-key"];
  const actual = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : typeof apiKey === "string" ? apiKey : "";
  const left = Buffer.from(actual); const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorizedSmart(request: IncomingMessage, token: string): boolean {
  const actual = singleHeader(request, SMART_TOKEN_HEADER);
  const left = Buffer.from(actual);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function singleHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return typeof value === "string" && value.length <= 16 * 1024 ? value : "";
}

function validIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function validSecretHeader(value: string): boolean {
  return value.length > 7 && value.length <= 16 * 1024 && /^Bearer [^\s\u0000-\u001f\u007f]+$/u.test(value);
}

function smartRootRoute(state: SmartBindingState): ActiveSmartThreadRoute {
  if (state.rootProviderId === undefined || state.rootModelId === undefined) throw unavailable();
  const native = state.rootProviderId === state.nativeProviderId;
  if (!native && state.rootRevision === undefined) throw unavailable();
  return {
    kind: "internal",
    providerId: state.rootProviderId,
    modelId: state.rootModelId,
    ...(state.rootRevision === undefined ? {} : { revision: state.rootRevision }),
    native
  };
}

function sameSmartThreadRoute(left: ActiveSmartThreadRoute, right: ActiveSmartThreadRoute): boolean {
  return left.kind === right.kind
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.revision === right.revision
    && left.native === right.native;
}

function requestSuffix(protocol: ProviderRuntimeProtocol, path: string): string | undefined {
  if (protocol === "openai-responses") return path === "/responses" ? "" : path === "/responses/compact" ? "/compact" : undefined;
  if (protocol === "anthropic-messages") return path === "/v1/messages" ? "" : path === "/v1/messages/count_tokens" ? "/count_tokens" : undefined;
  return undefined;
}

function unavailable(): Error { return new Error("The exact managed Provider route is unavailable."); }
function fail(response: ServerResponse, status: number): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { type: "api_error", message: "The managed Provider request could not be completed." } }));
}
