import { randomUUID } from "node:crypto";

import { RevisionConflictError, type OperationalStore } from "@joko/store";

import { backendModelAccessSettingKey, modelRoutingEnabled, readBackendModelAccess } from "./backend-model-access.js";
import type { ProviderCatalogManager } from "./credential-manager.js";
import {
  requestManagedTextInference,
  type ModelRouteCatalog,
  type ModelRouteRef
} from "./personalization-inference.js";

export const AUXILIARY_TEXT_SETTING_KEY = "settings.auxiliary_text";
const MAXIMUM_MODELS = 3;
const MAXIMUM_ATTEMPT_TIME_MS = 20_000;
const MAXIMUM_CHAIN_TIME_MS = 60_000;

export interface AuxiliaryTextRouteOption {
  readonly route: ModelRouteRef;
  readonly available: boolean;
  readonly unavailableReason: string;
}

export interface AuxiliaryTextSnapshot {
  readonly models: readonly ModelRouteRef[];
  readonly automaticModels: readonly ModelRouteRef[];
  readonly options: readonly AuxiliaryTextRouteOption[];
  readonly available: boolean;
  readonly unavailableReason: string;
  readonly revision: bigint;
  readonly runtimeRevision: string;
}

export interface AuxiliaryTextPlan {
  readonly models: readonly ModelRouteRef[];
  readonly revision: bigint;
  readonly runtimeRevision: string;
}

export interface AuxiliaryTextRunOptions {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stillCurrent?: () => boolean;
  readonly validate: (raw: string) => string | undefined;
}

export type AuxiliaryTextRunResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "unavailable" | "exhausted" | "cancelled" | "stale" };

export interface AuxiliaryTextRoutingOptions {
  readonly store: OperationalStore;
  readonly routes: ModelRouteCatalog;
  readonly providers: Pick<ProviderCatalogManager, "describeInferenceRoute" | "generation">;
  readonly infer?: typeof requestManagedTextInference;
}

interface RoutingState extends Omit<AuxiliaryTextSnapshot, "runtimeRevision"> {
  readonly identity: string;
}

/** One service-owned, ordered auxiliary text chain; no Session credential borrowing. */
export class AuxiliaryTextRouting {
  readonly #store: OperationalStore;
  readonly #routes: ModelRouteCatalog;
  readonly #providers: AuxiliaryTextRoutingOptions["providers"];
  readonly #infer: typeof requestManagedTextInference;
  readonly #incarnation = randomUUID();
  readonly #plans = new WeakSet<AuxiliaryTextPlan>();
  readonly #flights = new Set<AbortController>();
  #identity: string | undefined;
  #epoch = 0;
  #disposed = false;

  constructor(options: AuxiliaryTextRoutingOptions) {
    this.#store = options.store;
    this.#routes = options.routes;
    this.#providers = options.providers;
    this.#infer = options.infer ?? requestManagedTextInference;
  }

  snapshot(): AuxiliaryTextSnapshot {
    const { identity, ...state } = this.#readState();
    if (identity !== this.#identity) {
      this.#identity = identity;
      this.#epoch += 1;
      this.#abortFlights();
    }
    return { ...state, runtimeRevision: `${this.#incarnation}:${this.#epoch}` };
  }

  /** Called synchronously inside the authenticated operation's Store transaction. */
  replace(models: readonly ModelRouteRef[], expectedRevision: bigint): void {
    if (this.#disposed) throw new Error("Auxiliary text routing is disposed.");
    const current = this.#store.findSetting<unknown>("service", "orchestrator", AUXILIARY_TEXT_SETTING_KEY);
    const revision = current?.revision ?? 0n;
    if (revision !== expectedRevision) {
      throw new RevisionConflictError("Auxiliary text settings", AUXILIARY_TEXT_SETTING_KEY, expectedRevision, revision);
    }
    const next = normalizeModels(models);
    const previous = readModels(current?.value)?.models ?? [];
    const catalog = this.#routes.list();
    for (const reference of next) {
      if (previous.some((value) => routeKey(value) === routeKey(reference))) continue;
      const candidate = catalog.find((value) => routeKey(value) === routeKey(reference));
      if (candidate?.credentialRoute !== true || !this.#routeEnabled(reference)) {
        throw new RangeError("Auxiliary text model is not an enabled managed inference route.");
      }
    }
    // Reset keeps a durable empty chain and its revision, preventing revision-zero ABA.
    this.#store.setSetting("service", "orchestrator", AUXILIARY_TEXT_SETTING_KEY, { models: next });
  }

  /** Invoke only after the settings operation has durably committed. */
  invalidate(): void {
    this.snapshot();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.invalidate();
  }

  capture(): AuxiliaryTextPlan {
    const state = this.snapshot();
    const plan = Object.freeze({
      models: Object.freeze((state.models.length === 0 ? state.automaticModels : state.models)
        .map((reference) => Object.freeze({ ...reference }))),
      revision: state.revision,
      runtimeRevision: state.runtimeRevision
    });
    this.#plans.add(plan);
    return plan;
  }

  isCurrent(plan: AuxiliaryTextPlan): boolean {
    if (this.#disposed || !this.#plans.has(plan)) return false;
    const state = this.snapshot();
    return plan.revision === state.revision && plan.runtimeRevision === state.runtimeRevision;
  }

  async run(plan: AuxiliaryTextPlan, input: AuxiliaryTextRunOptions): Promise<AuxiliaryTextRunResult> {
    const stopped = (): AuxiliaryTextRunResult | undefined => {
      if (input.signal?.aborted || this.#disposed) return { status: "cancelled" };
      if (!this.isCurrent(plan) || input.stillCurrent?.() === false) return { status: "stale" };
      return undefined;
    };
    const initial = stopped();
    if (initial !== undefined) return initial;
    if (!this.snapshot().available || plan.models.length === 0) return { status: "unavailable" };
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 5 * 60_000) {
      throw new RangeError("Auxiliary text inference timeout is invalid.");
    }
    const owner = new AbortController();
    this.#flights.add(owner);
    const deadline = AbortSignal.timeout(MAXIMUM_CHAIN_TIME_MS);
    const signal = AbortSignal.any([owner.signal, deadline, ...(input.signal === undefined ? [] : [input.signal])]);
    let attempted = false;
    try {
      for (const reference of plan.models) {
        const before = stopped();
        if (before !== undefined) return before;
        if (deadline.aborted) break;
        if (!this.snapshot().options.some((option) => option.available && routeKey(option.route) === routeKey(reference))) continue;
        const route = this.#routes.resolve(reference);
        const ready = stopped();
        if (ready !== undefined) return ready;
        if (route === undefined) continue;
        attempted = true;
        const attemptTimeout = AbortSignal.timeout(Math.min(input.timeoutMs, MAXIMUM_ATTEMPT_TIME_MS));
        const attemptSignal = AbortSignal.any([signal, attemptTimeout]);
        try {
          const raw = await waitForInference(this.#infer({
            route,
            system: input.system,
            user: input.user,
            maxTokens: input.maxTokens,
            timeoutMs: Math.min(input.timeoutMs, MAXIMUM_ATTEMPT_TIME_MS),
            signal: attemptSignal
          }), attemptSignal);
          const after = stopped();
          if (after !== undefined) return after;
          const text = input.validate(raw);
          const validated = stopped();
          if (validated !== undefined) return validated;
          if (text !== undefined && text.length > 0) return { status: "ok", text };
        } catch {
          const failed = stopped();
          if (failed !== undefined) return failed;
          if (deadline.aborted) break;
        }
      }
      return { status: attempted ? "exhausted" : "unavailable" };
    } finally {
      this.#flights.delete(owner);
      owner.abort();
    }
  }

  #abortFlights(): void {
    for (const flight of this.#flights) flight.abort();
  }

  #routeEnabled(reference: ModelRouteRef): boolean {
    const setting = this.#store.findSetting<{ readonly enabled?: boolean }>(
      "service", "orchestrator", `settings.backend.${reference.backendId}`
    );
    return setting?.value.enabled !== false && modelRoutingEnabled(
      this.#store, reference.backendId, reference.providerId, reference.modelId
    );
  }

  #readState(): RoutingState {
    const stored = this.#store.findSetting<unknown>("service", "orchestrator", AUXILIARY_TEXT_SETTING_KEY);
    const configured = stored === undefined ? { models: [] } : readModels(stored.value);
    const models = configured?.models ?? [];
    const catalog = this.#routes.list();
    const backends = this.#store.listBackends();
    const descriptors = new Map(catalog.map((descriptor) => [routeKey(descriptor), descriptor]));
    const backendStates = new Map(backends.map((backend) => {
      const id = backend.descriptor.id;
      const setting = this.#store.findSetting<{ readonly enabled?: boolean; readonly defaultModel?: {
        readonly model?: { readonly providerId?: string; readonly modelId?: string }
      } }>("service", "orchestrator", `settings.backend.${id}`);
      const access = this.#store.findSetting("service", "orchestrator", backendModelAccessSettingKey(id));
      return [id, { backend, setting, access, modelAccess: readBackendModelAccess(this.#store, id) }] as const;
    }));
    const references = new Map<string, ModelRouteRef>();
    for (const reference of [...catalog, ...models]) references.set(routeKey(reference), copyRoute(reference));
    const privateRoutes: unknown[] = [];
    const options: AuxiliaryTextRouteOption[] = [...references.values()].sort(compareRoutes).map((reference) => {
      const descriptor = descriptors.get(routeKey(reference));
      const state = backendStates.get(reference.backendId);
      const enabled = state !== undefined && state.setting?.value.enabled !== false
        && !state.modelAccess.disabledProviderIds.includes(reference.providerId)
        && !state.modelAccess.disabledModels.some((model) => model.providerId === reference.providerId && model.modelId === reference.modelId);
      const identity = descriptor?.credentialRoute === true && enabled
        ? this.#providers.describeInferenceRoute(reference.backendId, reference.providerId, reference.modelId)
        : undefined;
      privateRoutes.push([
        routeKey(reference), state?.backend.descriptor.instanceGeneration,
        state?.setting?.revision.toString(), state?.access?.revision.toString(), identity?.generationId, descriptor?.credentialRoute, enabled
      ]);
      const unavailableReason = descriptor === undefined || state === undefined ? "Model route is no longer in the catalog."
        : !enabled ? "Model route is disabled."
        : descriptor.credentialRoute !== true ? "Model route does not support managed text inference."
        : identity === undefined ? "Model route has no available managed credential."
        : "";
      return { route: reference, available: unavailableReason === "", unavailableReason };
    });
    const available = options.filter((option) => option.available).map((option) => option.route);
    const automatic = new Map<string, ModelRouteRef>();
    for (const backend of backends.sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id, "en"))) {
      const preferred = backendStates.get(backend.descriptor.id)?.setting?.value.defaultModel?.model;
      const reference = available.find((candidate) => candidate.backendId === backend.descriptor.id
        && candidate.providerId === preferred?.providerId && candidate.modelId === preferred?.modelId);
      if (reference !== undefined) automatic.set(routeKey(reference), reference);
    }
    for (const reference of available) automatic.set(routeKey(reference), reference);
    const automaticModels = [...automatic.values()].slice(0, MAXIMUM_MODELS);
    const effective = models.length === 0 ? automaticModels : models;
    const ready = configured !== undefined && !this.#disposed && effective.some((reference) =>
      options.some((option) => option.available && routeKey(option.route) === routeKey(reference)));
    const revision = stored?.revision ?? 0n;
    return {
      models, automaticModels, options, available: ready, revision,
      unavailableReason: configured === undefined ? "Auxiliary text settings are invalid."
        : this.#disposed ? "Auxiliary text routing is unavailable."
        : ready ? "" : "No configured auxiliary text model route is available.",
      identity: JSON.stringify([revision.toString(), configured !== undefined, this.#disposed, this.#providers.generation, privateRoutes, automaticModels])
    };
  }
}

function copyRoute(reference: ModelRouteRef): ModelRouteRef {
  return { backendId: reference.backendId, providerId: reference.providerId, modelId: reference.modelId };
}

function routeKey(reference: ModelRouteRef): string {
  return `${reference.backendId}\0${reference.providerId}\0${reference.modelId}`;
}

function compareRoutes(left: ModelRouteRef, right: ModelRouteRef): number {
  return left.backendId.localeCompare(right.backendId, "en")
    || left.providerId.localeCompare(right.providerId, "en") || left.modelId.localeCompare(right.modelId, "en");
}

function normalizeModels(value: readonly ModelRouteRef[]): ModelRouteRef[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_MODELS) throw new RangeError("Auxiliary text accepts at most three model routes.");
  const result: ModelRouteRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object") throw new RangeError("Auxiliary text model route is invalid.");
    for (const [key, maximum] of [["backendId", 128], ["providerId", 128], ["modelId", 256]] as const) {
      if (typeof item[key] !== "string" || item[key].length === 0 || item[key].length > maximum || /[\s\u0000-\u001f\u007f]/u.test(item[key])) {
        throw new RangeError("Auxiliary text model route is invalid.");
      }
    }
    const key = routeKey(item);
    if (seen.has(key)) throw new RangeError("Auxiliary text model routes must be unique.");
    seen.add(key);
    result.push(copyRoute(item));
  }
  return result;
}

function readModels(value: unknown): { readonly models: readonly ModelRouteRef[] } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !("models" in value) || !Array.isArray(value.models)) return undefined;
  try {
    if (value.models.some((item: unknown) => item === null || typeof item !== "object"
      || Object.keys(item).length !== 3 || Object.keys(item).some((key) => !["backendId", "providerId", "modelId"].includes(key)))) return undefined;
    return { models: normalizeModels(value.models) };
  } catch {
    return undefined;
  }
}

function waitForInference(inference: Promise<string>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Auxiliary inference cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void inference.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
