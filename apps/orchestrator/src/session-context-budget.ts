import { createHash, randomUUID } from "node:crypto";
import type { SessionDescriptor } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { ModelRouteTarget, ModelWorkingContextCoordinator } from "./model-working-context.js";

const KEY = "settings.context_budget";
interface Value { readonly format: 1; readonly tokens?: number; readonly editId: string }
export interface SessionContextBudgetView {
  readonly sessionId: string; readonly generation: number; readonly target?: ModelRouteTarget;
  readonly budgetTokens?: number; readonly defaultWindowTokens?: number; readonly maximumWindowTokens?: number; readonly modelLimitTokens?: number;
  readonly effectiveWindowTokens?: number; readonly revision: bigint; readonly sourceRevision: string; readonly canConfigure: boolean;
}
export interface SessionContextBudgetEdit {
  readonly sessionId: string; readonly generation: number; readonly tokens?: number;
  readonly expectedRevision: bigint; readonly expectedSourceRevision: string;
}
export class SessionContextBudgetError extends Error {
  constructor(readonly reason: "invalid" | "conflict" | "unsupported" | "apply_failed") { super(`Task context budget: ${reason}.`); }
}
/** Preferences belong to the original task. Backend contexts receive a frozen, route-clamped budget. */
export class SessionContextBudgetCoordinator {
  constructor(readonly store: OperationalStore, readonly models: ModelWorkingContextCoordinator,
    readonly refresh: (sessionId: string, target: ModelRouteTarget, check: () => void) => Promise<void>, readonly isReadOnly: (sessionId: string) => boolean) {}
  private value(sessionId: string): Value | undefined {
    const value = this.store.findSetting<unknown>("session", sessionId, KEY)?.value;
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionContextBudgetError("invalid");
    const row = value as Value;
    if (Object.keys(row).some(key => !["format", "tokens", "editId"].includes(key)) || row.format !== 1 || !row.editId || row.tokens !== undefined && !valid(row.tokens)) throw new SessionContextBudgetError("invalid");
    return row;
  }
  resolve(sessionId: string, target: ModelRouteTarget): number | undefined {
    const fallback = this.models.resolve(target), budget = this.value(sessionId)?.tokens;
    if (budget === undefined || !this.models.options.currentOwner()) return fallback;
    const route = this.models.options.resolveRoute(target);
    if (!route?.supported) return fallback;
    const maximum = route.model.contextWindowSource !== "estimated" && route.model.contextWindow > 0 ? route.model.contextWindow : undefined;
    const caps = [budget, maximum, this.models.configuredLimit(target)].filter((value): value is number => value !== undefined);
    return Math.min(...caps);
  }
  read(sessionId: string, generation: number): SessionContextBudgetView {
    if (!sessionId || !Number.isSafeInteger(generation) || generation < 1) throw new SessionContextBudgetError("invalid");
    const session = this.store.getSession(sessionId).descriptor;
    if (session.binding.generation !== generation || session.deletedAt !== undefined) throw new SessionContextBudgetError("conflict");
    const target = routeTarget(session), route = target ? this.models.options.resolveRoute(target) : undefined;
    const record = this.store.findSetting<unknown>("session", sessionId, KEY), value = this.value(sessionId);
    const modelLimitTokens = target ? this.models.configuredLimit(target) : undefined;
    const maximumWindowTokens = route && route.model.contextWindowSource !== "estimated" && route.model.contextWindow > 0 ? route.model.contextWindow : undefined;
    const defaultWindowTokens = route && route.model.contextWindow > 0 ? Math.min(route.model.contextWindow, modelLimitTokens ?? Infinity, maximumWindowTokens ?? Infinity) : undefined;
    const modelSource = target ? this.models.options.resolveRoute(target) : undefined;
    const owner = this.models.options.currentOwner();
    const sourceRevision = createHash("sha256").update(JSON.stringify([sessionId, generation, target, session.archived, this.isReadOnly(sessionId), owner,
      modelSource?.catalogRevision.toString(), modelSource?.instanceGeneration, modelSource?.providerRevision?.toString(), modelSource?.supported,
      modelSource?.available, modelSource?.model.contextWindow, modelSource?.model.contextWindowSource, modelLimitTokens])).digest("hex");
    return { sessionId, generation, target, budgetTokens: value?.tokens, defaultWindowTokens, maximumWindowTokens, modelLimitTokens,
      effectiveWindowTokens: target ? this.resolve(sessionId, target) : undefined, revision: record?.revision ?? 0n, sourceRevision,
      canConfigure: !!owner && !!target && route?.supported === true && route.available && !session.archived && !this.isReadOnly(sessionId) };
  }
  async set(edit: SessionContextBudgetEdit, assertAuthority: () => void): Promise<void> {
    if (edit.tokens !== undefined && !valid(edit.tokens)) throw new SessionContextBudgetError("invalid");
    const initial = this.read(edit.sessionId, edit.generation);
    if (initial.revision !== edit.expectedRevision || initial.sourceRevision !== edit.expectedSourceRevision) throw new SessionContextBudgetError("conflict");
    if (!initial.canConfigure || !initial.target) throw new SessionContextBudgetError("unsupported");
    const before = this.value(edit.sessionId), editId = randomUUID();
    assertAuthority();
    this.store.setSetting("session", edit.sessionId, KEY, { format: 1, ...(edit.tokens === undefined ? {} : { tokens: edit.tokens }), editId } satisfies Value);
    const check = () => {
      assertAuthority(); const current = this.read(edit.sessionId, edit.generation);
      if (this.value(edit.sessionId)?.editId !== editId || current.sourceRevision !== initial.sourceRevision) throw new SessionContextBudgetError("conflict");
    };
    try { check(); await this.refresh(edit.sessionId, initial.target, check); check(); }
    catch (error) {
      if (this.value(edit.sessionId)?.editId === editId) {
        this.store.setSetting("session", edit.sessionId, KEY, before ?? { format: 1, editId: randomUUID() });
        try { await this.refresh(edit.sessionId, initial.target, assertAuthority); } catch { /* Keep the original apply failure public. */ }
      }
      throw error instanceof SessionContextBudgetError ? error : new SessionContextBudgetError("apply_failed");
    }
  }
}
function valid(value: number): boolean { return Number.isSafeInteger(value) && value >= 1_000 && value <= 100_000_000; }
function routeTarget(session: SessionDescriptor): ModelRouteTarget | undefined {
  return session.providerId && session.modelId ? { backendId: session.backendId, providerId: session.providerId, modelId: session.modelId } : undefined;
}
