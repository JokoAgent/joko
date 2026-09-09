import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { piProviderModel } from "@joko/adapter-pi";
import type {
  BackendProviderDescriptor, ManagedProviderOperationLease, ManagedProviderRouteBinding,
  ManagedProviderRouteOwner, ManagedProviderRuntimePort, ProviderRuntimeProtocol, ProviderRuntimeSupport
} from "@joko/core";
import type { ProviderCatalogManager, ProviderInferenceRoute } from "./credential-manager.js";

const BODY_LIMIT = 32 * 1024 * 1024;
const ENVIRONMENT_NAME = "JOKO_PROVIDER_PROXY_TOKEN";
const MAXIMUM_BINDINGS = 4_096;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

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

/** Node-private native HTTP transport. Public RPC, Store and native config never receive its token. */
export class ManagedProviderProxy {
  readonly #server: Server;
  readonly #providers: ProviderCatalogManager;
  readonly #fetch: typeof fetch;
  readonly #assertOwner: (owner: ManagedProviderRouteOwner) => void;
  readonly #bindings = new Map<string, BindingState>();
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
        if (this.#bindings.size >= MAXIMUM_BINDINGS) throw new Error("Managed Provider route capacity is exhausted.");
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
              abort.abort();
            };
            const active: ActiveOperation = { operationId: operation.operationId, route, abort,
              assertCurrent: operation.assertCurrent, release };
            state.active = active;
            operation.signal.addEventListener("abort", release, { once: true });
            if (operation.signal.aborted) release();
            return { release } satisfies ManagedProviderOperationLease;
          },
          dispose: () => { state.active?.release(); this.#bindings.delete(state.id); }
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

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    const signal = AbortSignal.any([operation.abort.signal, abort.signal]);
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
        || (parsed as { model?: unknown }).model !== state.modelId) { fail(response, 400); return; }
      const route = operation.route;
      const base = new URL(route.baseUrl.endsWith("/") ? route.baseUrl : `${route.baseUrl}/`);
      const endpoint = route.requestPath === undefined
        ? new URL(match![2]!.slice(1), base)
        : new URL(`${route.requestPath.replace(/\/$/u, "")}${suffix}`, base.origin);
      if (endpoint.origin !== base.origin) throw unavailable();
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream, application/json" });
      for (const name of ["anthropic-version", "anthropic-beta", "openai-beta", "x-codex-turn-metadata", "session_id"]) {
        const value = request.headers[name]; if (typeof value === "string") headers.set(name, value);
      }
      for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
      if (route.authorization !== undefined) headers.set("authorization", route.authorization);
      this.#assertOperation(state, operation);
      const upstream = await this.#fetch(endpoint, { method: "POST", headers, body, redirect: "manual", signal });
      this.#assertOperation(state, operation);
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
          this.#assertOperation(state, operation);
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
