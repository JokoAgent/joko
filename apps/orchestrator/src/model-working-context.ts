import { createHash, randomUUID } from "node:crypto";
import type { ProviderModel } from "@joko/core";
import type { OperationalStore } from "@joko/store";

const SETTING_KEY = "settings.model_working_context";
const MAXIMUM_ENTRIES = 4096;
export interface ModelRouteTarget { readonly backendId: string; readonly providerId: string; readonly modelId: string }
export interface ModelWorkingContextRoute {
  readonly model: ProviderModel;
  readonly catalogRevision: bigint;
  readonly instanceGeneration: number;
  readonly providerRevision?: bigint;
  readonly supported: boolean;
  readonly available: boolean;
}
export interface ModelNativeContextInfo {
  readonly contextWindowTokens?: number;
  readonly autoCompactLimitTokens?: number;
  readonly source: "native_usage" | "native_configuration";
  readonly pendingApply: boolean;
}
export interface ModelWorkingContextQuery {
  readonly target: ModelRouteTarget;
  readonly relatedTargets?: readonly ModelRouteTarget[];
  readonly sessionId?: string;
}
export interface ModelWorkingContextEdit extends ModelWorkingContextQuery {
  readonly limit?: number;
  readonly expectedRevision: bigint;
  readonly expectedSourceRevision: string;
  readonly operationId: string;
}
export interface ModelWorkingContextView {
  readonly target: ModelRouteTarget;
  readonly limitTokens?: number;
  readonly defaultContextWindowTokens?: number;
  readonly effectiveContextWindowTokens?: number;
  readonly customized: boolean;
  readonly mixed: boolean;
  readonly revision: bigint;
  readonly sourceRevision: string;
  readonly canConfigure: boolean;
  readonly blockedReason?: "model_unavailable" | "unsupported";
  readonly nativeContext?: ModelNativeContextInfo;
}
export interface ModelWorkingContextOptions {
  readonly store: OperationalStore;
  readonly currentOwner: () => { readonly ownerId: string; readonly generation: number } | undefined;
  readonly resolveRoute: (target: ModelRouteTarget) => ModelWorkingContextRoute | undefined;
  readonly refresh: (targets: readonly ModelRouteTarget[], assertCurrent: () => void, signal?: AbortSignal) => Promise<void>;
  readonly readNativeContext?: (target: ModelRouteTarget, sessionId: string | undefined, signal?: AbortSignal) => Promise<ModelNativeContextInfo | undefined>;
}
interface Entry { readonly target: ModelRouteTarget; readonly overrideTokens?: number; readonly lastEditId: string }
interface State { readonly format: 1; readonly entries: readonly Entry[] }
export class ModelWorkingContextError extends Error {
  constructor(readonly reason: "invalid" | "conflict" | "owner_changed" | "unsupported" | "refresh_failed" | "cancelled") {
    super(reason === "refresh_failed" ? "The model working context could not be applied. Read the current setting before retrying."
      : reason === "conflict" ? "The model working context changed. Read the current setting before retrying."
        : reason === "owner_changed" ? "The model settings owner changed."
          : reason === "cancelled" ? "The model settings request was cancelled."
            : reason === "unsupported" ? "This model route does not support working context settings."
              : "The model working context request is invalid.");
  }
}

/** Explicit working budgets, independent of catalog capacities and managed-runtime configuration. */
export class ModelWorkingContextCoordinator {
  constructor(readonly options: ModelWorkingContextOptions) {}
  resolve(target: ModelRouteTarget): number | undefined {
    const owner = this.options.currentOwner();
    if (!owner) return undefined;
    const route = this.options.resolveRoute(target);
    if (!route?.supported) return undefined;
    return this.state(owner.ownerId).entries.find(entry => key(entry.target) === key(target))?.overrideTokens
      ?? validDefault(route.model.contextWindow);
  }
  async read(query: ModelWorkingContextQuery, signal?: AbortSignal): Promise<ModelWorkingContextView> {
    const targets = validateTargets(query); const owner = this.owner(signal);
    const source = this.source(targets);
    const nativeContext = await this.options.readNativeContext?.(targets[0]!, query.sessionId, signal);
    this.assertOwner(owner, signal);
    if (source.revision !== this.source(targets).revision) throw new ModelWorkingContextError("conflict");
    const result = this.view(owner.ownerId, targets, source);
    return nativeContext === undefined ? result : { ...result, nativeContext };
  }
  async set(edit: ModelWorkingContextEdit, signal?: AbortSignal): Promise<ModelWorkingContextView> {
    const targets = validateTargets(edit); const owner = this.owner(signal);
    if (!text(edit.operationId) || typeof edit.expectedSourceRevision !== "string" || typeof edit.expectedRevision !== "bigint") throw new ModelWorkingContextError("invalid");
    if (edit.limit !== undefined && !validLimit(edit.limit)) throw new ModelWorkingContextError("invalid");
    const source = this.source(targets);
    const setting = this.options.store.findSetting<unknown>("service", owner.ownerId, SETTING_KEY);
    if ((setting?.revision ?? 0n) !== edit.expectedRevision || source.revision !== edit.expectedSourceRevision) throw new ModelWorkingContextError("conflict");
    if (edit.limit !== undefined && source.routes.some(route => route === undefined || !route.supported || !route.available)) throw new ModelWorkingContextError("unsupported");
    const before = this.state(owner.ownerId).entries;
    const writtenId = randomUUID();
    const changed = new Set(targets.map(key));
    const entries = before.filter(entry => !changed.has(key(entry.target)));
    const receiptTargets = edit.limit === undefined ? targets.filter(target => before.some(entry => key(entry.target) === key(target))) : targets;
    const receipts = new Set(receiptTargets.map(key));
    entries.push(...receiptTargets.map(target => ({ target, lastEditId: writtenId, ...(edit.limit === undefined ? {} : { overrideTokens: edit.limit }) })));
    if (entries.length > MAXIMUM_ENTRIES) throw new ModelWorkingContextError("invalid");
    this.assertOwner(owner, signal);
    this.write(owner.ownerId, entries);
    const assertCurrent = (): void => {
      this.assertOwner(owner, signal);
      if (this.source(targets).revision !== source.revision) throw new ModelWorkingContextError("conflict");
      const current = this.state(owner.ownerId).entries;
      if (targets.some(target => current.find(entry => key(entry.target) === key(target))?.lastEditId !== (receipts.has(key(target)) ? writtenId : undefined))) throw new ModelWorkingContextError("conflict");
    };
    try {
      assertCurrent(); await this.options.refresh(targets, assertCurrent, signal); assertCurrent();
      // A successful reset leaves no override or rollback receipt on disk.
      if (edit.limit === undefined) this.write(owner.ownerId, this.state(owner.ownerId).entries.filter(entry => entry.lastEditId !== writtenId));
      return this.view(owner.ownerId, targets, this.source(targets));
    } catch (error) {
      // This exact edit owns only its target keys; unrelated and newer writes survive, including ABA.
      {
        const current = this.state(owner.ownerId).entries;
        const rollbackKeys = new Set(current.filter(entry => changed.has(key(entry.target)) && entry.lastEditId === writtenId).map(entry => key(entry.target)));
        if (rollbackKeys.size > 0) {
          const restored = current.filter(entry => !rollbackKeys.has(key(entry.target)));
          restored.push(...before.filter(entry => rollbackKeys.has(key(entry.target))));
          this.write(owner.ownerId, restored);
          const currentOwner = this.options.currentOwner();
          if (currentOwner?.ownerId === owner.ownerId && currentOwner.generation === owner.generation) {
            try { await this.options.refresh(targets.filter(target => rollbackKeys.has(key(target))), () => this.assertOwner(owner), undefined); } catch { /* Original failed apply remains the finite public result. */ }
          }
        }
      }
      if (error instanceof ModelWorkingContextError) throw error;
      throw new ModelWorkingContextError(signal?.aborted ? "cancelled" : "refresh_failed");
    }
  }
  private owner(signal?: AbortSignal) {
    if (signal?.aborted) throw new ModelWorkingContextError("cancelled");
    const owner = this.options.currentOwner(); if (!owner || !text(owner.ownerId) || !Number.isSafeInteger(owner.generation)) throw new ModelWorkingContextError("owner_changed"); return owner;
  }
  private assertOwner(owner: { readonly ownerId: string; readonly generation: number }, signal?: AbortSignal): void {
    const current = this.owner(signal); if (current.ownerId !== owner.ownerId || current.generation !== owner.generation) throw new ModelWorkingContextError("owner_changed");
  }
  private source(targets: readonly ModelRouteTarget[]) {
    const routes = targets.map(target => this.options.resolveRoute(target));
    const revision = createHash("sha256").update(JSON.stringify(targets.map((target, index) => {
      const route = routes[index]; return [target, route === undefined ? null : [route.catalogRevision.toString(), route.instanceGeneration,
        route.providerRevision?.toString() ?? null, route.supported, route.available, route.model.contextWindow]];
    }))).digest("hex");
    return { routes, revision };
  }
  private view(ownerId: string, targets: readonly ModelRouteTarget[], source: ReturnType<ModelWorkingContextCoordinator["source"]>): ModelWorkingContextView {
    const record = this.options.store.findSetting<unknown>("service", ownerId, SETTING_KEY);
    const entries = this.state(ownerId).entries;
    const values = targets.map(target => entries.find(entry => key(entry.target) === key(target))?.overrideTokens);
    const limitTokens = values.find(value => value !== undefined); const primary = source.routes[0];
    const defaultContextWindowTokens = primary === undefined ? undefined : validDefault(primary.model.contextWindow);
    const canConfigure = source.routes.every(route => route !== undefined && route.supported && route.available);
    return { target: targets[0]!, ...(limitTokens === undefined ? {} : { limitTokens }),
      ...(defaultContextWindowTokens === undefined ? {} : { defaultContextWindowTokens }),
      ...((values[0] ?? defaultContextWindowTokens) === undefined ? {} : { effectiveContextWindowTokens: values[0] ?? defaultContextWindowTokens }),
      customized: values.some(value => value !== undefined), mixed: values.some(value => value !== values[0]),
      revision: record?.revision ?? 0n, sourceRevision: source.revision, canConfigure,
      ...(canConfigure ? {} : { blockedReason: source.routes.some(route => route === undefined) ? "model_unavailable" as const : "unsupported" as const }) };
  }
  private state(ownerId: string): State {
    const value = this.options.store.findSetting<unknown>("service", ownerId, SETTING_KEY)?.value;
    if (value === undefined) return { format: 1, entries: [] };
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(field => field !== "format" && field !== "entries")) throw new ModelWorkingContextError("invalid");
    const state = value as State;
    if (state.format !== 1 || !Array.isArray(state.entries) || state.entries.length > MAXIMUM_ENTRIES) throw new ModelWorkingContextError("invalid");
    const seen = new Set<string>();
    for (const entry of state.entries) {
      if (!entry || typeof entry !== "object" || Object.keys(entry).some(field => !["target", "overrideTokens", "lastEditId"].includes(field)) || !text(entry.lastEditId)
        || (entry.overrideTokens !== undefined && !validLimit(entry.overrideTokens))) throw new ModelWorkingContextError("invalid");
      validateTarget(entry.target); if (seen.has(key(entry.target))) throw new ModelWorkingContextError("invalid"); seen.add(key(entry.target));
    }
    return state;
  }
  private write(ownerId: string, entries: readonly Entry[]): void {
    this.options.store.setSetting("service", ownerId, SETTING_KEY, { format: 1, entries } satisfies State);
  }
}
function key(target: ModelRouteTarget): string { return JSON.stringify([target.backendId, target.providerId, target.modelId]); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !value.includes("\0"); }
function validLimit(value: number): boolean { return Number.isSafeInteger(value) && value >= 1000 && value <= 100_000_000; }
function validDefault(value: number): number | undefined { return Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function validateTarget(target: ModelRouteTarget): void {
  if (!target || typeof target !== "object" || Object.keys(target).some(field => !["backendId", "providerId", "modelId", "$typeName"].includes(field))
    || !text(target.backendId) || !text(target.providerId) || !text(target.modelId)) throw new ModelWorkingContextError("invalid");
}
function validateTargets(query: ModelWorkingContextQuery): readonly ModelRouteTarget[] {
  const targets = [query.target, ...(query.relatedTargets ?? [])];
  if (targets.length > 3) throw new ModelWorkingContextError("invalid");
  const backends = new Set<string>();
  for (const target of targets) {
    validateTarget(target); if (target.providerId !== targets[0]!.providerId || backends.has(target.backendId)) throw new ModelWorkingContextError("invalid"); backends.add(target.backendId);
  }
  return targets.map(target => ({ backendId: target.backendId, providerId: target.providerId, modelId: target.modelId }));
}
