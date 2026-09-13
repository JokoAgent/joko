import type { ProviderModel } from "@joko/core";

export type SessionRuntimeMutationSource = "agent" | "fallback";

export interface SessionRuntimeProfile {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
}

export interface SessionRuntimePatch {
  readonly providerId?: string | null;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode?: boolean;
}

export interface SessionRuntimeAxisPatch {
  /** Null is an internal owner selection for a fixed-effort model. */
  readonly effort?: string | null;
  readonly fastMode?: boolean;
}

export interface PendingSessionRuntimeMutation {
  readonly generation: number;
  readonly source: SessionRuntimeMutationSource;
  readonly profile: SessionRuntimeProfile;
}

export interface SessionRuntimeControlSnapshot {
  readonly generation: number;
  readonly baseline?: SessionRuntimeProfile;
  readonly effective?: SessionRuntimeProfile;
  readonly pending?: PendingSessionRuntimeMutation;
  readonly fallbackHop: number;
  readonly visitedRoutes: readonly string[];
}

interface SessionRuntimeControlState {
  generation: number;
  effectiveOverride?: SessionRuntimeProfile;
  pending?: PendingSessionRuntimeMutation;
  fallbackHop: number;
  readonly visitedRoutes: Set<string>;
}

export class SessionRuntimeControlRegistry {
  readonly #states = new Map<string, SessionRuntimeControlState>();

  snapshot(sessionId: string, baseline: SessionRuntimeProfile | undefined): SessionRuntimeControlSnapshot {
    const state = this.#states.get(sessionId);
    return {
      generation: state?.generation ?? 0,
      ...(baseline === undefined ? {} : { baseline }),
      ...((state?.effectiveOverride ?? baseline) === undefined
        ? {}
        : { effective: state?.effectiveOverride ?? baseline }),
      ...(state?.pending === undefined ? {} : { pending: state.pending }),
      fallbackHop: state?.fallbackHop ?? 0,
      visitedRoutes: state === undefined ? [] : [...state.visitedRoutes]
    };
  }

  generationMatches(sessionId: string, expectedGeneration: number): boolean {
    return (this.#states.get(sessionId)?.generation ?? 0) === expectedGeneration;
  }

  acceptApplied(
    sessionId: string,
    source: SessionRuntimeMutationSource,
    profile: SessionRuntimeProfile,
    previous?: SessionRuntimeProfile
  ): SessionRuntimeControlSnapshot {
    const state = this.#stateFor(sessionId);
    state.generation += 1;
    state.effectiveOverride = profile;
    state.pending = undefined;
    this.#recordRouteMutation(state, source, profile, previous);
    return this.snapshot(sessionId, undefined);
  }

  acceptDeferred(
    sessionId: string,
    source: SessionRuntimeMutationSource,
    profile: SessionRuntimeProfile,
    previous?: SessionRuntimeProfile
  ): SessionRuntimeControlSnapshot {
    const state = this.#stateFor(sessionId);
    state.generation += 1;
    state.pending = { generation: state.generation, source, profile };
    this.#recordRouteMutation(state, source, profile, previous);
    return this.snapshot(sessionId, undefined);
  }

  acceptAppliedAxis(
    sessionId: string,
    source: SessionRuntimeMutationSource,
    profile: SessionRuntimeProfile,
    pendingProfile?: SessionRuntimeProfile
  ): SessionRuntimeControlSnapshot {
    const state = this.#stateFor(sessionId);
    state.generation += 1;
    state.effectiveOverride = profile;
    if (state.pending !== undefined && pendingProfile !== undefined) {
      state.pending = {
        ...state.pending,
        generation: state.generation,
        profile: pendingProfile
      };
    }
    this.#recordAxisMutation(state, source);
    return this.snapshot(sessionId, undefined);
  }

  acceptDeferredAxis(
    sessionId: string,
    source: SessionRuntimeMutationSource,
    effectiveProfile: SessionRuntimeProfile,
    pendingProfile: SessionRuntimeProfile
  ): SessionRuntimeControlSnapshot {
    const state = this.#stateFor(sessionId);
    state.generation += 1;
    state.pending = state.pending === undefined
      ? { generation: state.generation, source, profile: pendingProfile }
      : { ...state.pending, generation: state.generation, profile: pendingProfile };
    this.#recordAxisMutation(state, source);
    return this.snapshot(sessionId, undefined);
  }

  settlePending(sessionId: string, generation: number): boolean {
    const state = this.#states.get(sessionId);
    if (state?.pending?.generation !== generation || state.generation !== generation) return false;
    state.effectiveOverride = state.pending.profile;
    state.pending = undefined;
    return true;
  }

  recordUserSelection(sessionId: string): number {
    const state = this.#stateFor(sessionId);
    state.generation += 1;
    state.effectiveOverride = undefined;
    state.pending = undefined;
    state.fallbackHop = 0;
    state.visitedRoutes.clear();
    return state.generation;
  }

  recordUserAxisSelection(
    sessionId: string,
    patch: SessionRuntimeAxisPatch,
    pendingPatch: SessionRuntimeAxisPatch = patch
  ): number {
    const state = this.#stateFor(sessionId);
    state.generation += 1;
    if (state.effectiveOverride !== undefined) {
      state.effectiveOverride = applySessionRuntimeAxisPatch(state.effectiveOverride, patch);
    }
    if (state.pending !== undefined) {
      state.pending = {
        ...state.pending,
        generation: state.generation,
        profile: applySessionRuntimeAxisPatch(state.pending.profile, pendingPatch)
      };
    }
    state.fallbackHop = 0;
    state.visitedRoutes.clear();
    return state.generation;
  }

  recordFailedFallbackCandidate(
    sessionId: string,
    expectedGeneration: number,
    profile: SessionRuntimeProfile
  ): boolean {
    const state = this.#stateFor(sessionId);
    if (state.generation !== expectedGeneration) return false;
    state.visitedRoutes.add(sessionRuntimeRouteKey(profile));
    return true;
  }

  clear(sessionId: string): void {
    this.#states.delete(sessionId);
  }

  clearAll(): void {
    this.#states.clear();
  }

  #stateFor(sessionId: string): SessionRuntimeControlState {
    const current = this.#states.get(sessionId);
    if (current !== undefined) return current;
    const created: SessionRuntimeControlState = {
      generation: 0,
      fallbackHop: 0,
      visitedRoutes: new Set()
    };
    this.#states.set(sessionId, created);
    return created;
  }

  #recordRouteMutation(
    state: SessionRuntimeControlState,
    source: SessionRuntimeMutationSource,
    profile: SessionRuntimeProfile,
    previous: SessionRuntimeProfile | undefined
  ): void {
    if (source === "agent") {
      state.fallbackHop = 0;
      state.visitedRoutes.clear();
      return;
    }
    state.fallbackHop += 1;
    if (previous !== undefined) state.visitedRoutes.add(sessionRuntimeRouteKey(previous));
    state.visitedRoutes.add(sessionRuntimeRouteKey(profile));
  }

  #recordAxisMutation(state: SessionRuntimeControlState, source: SessionRuntimeMutationSource): void {
    if (source !== "agent") return;
    state.fallbackHop = 0;
    state.visitedRoutes.clear();
  }
}

export function sessionRuntimeBaseline(input: {
  readonly backendId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
}): SessionRuntimeProfile | undefined {
  return input.providerId === undefined || input.modelId === undefined
    ? undefined
    : {
        backendId: input.backendId,
        providerId: input.providerId,
        modelId: input.modelId,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        fastMode: input.fastMode
      };
}

export function resolveSessionRuntimeProfile(input: {
  readonly baseline: SessionRuntimeProfile;
  readonly current: SessionRuntimeProfile;
  readonly patch: SessionRuntimePatch;
  readonly models: readonly ProviderModel[];
  readonly fastModeSupported: boolean;
}): SessionRuntimeProfile | undefined {
  const modelId = input.patch.modelId ?? input.current.modelId;
  const requestedProvider = input.patch.providerId;
  let providerId = requestedProvider === null
    ? input.baseline.modelId === modelId ? input.baseline.providerId : undefined
    : requestedProvider ?? input.current.providerId;
  let model = providerId === undefined
    ? undefined
    : input.models.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
  if (model === undefined && requestedProvider === undefined) {
    model = input.models.find((candidate) => candidate.modelId === modelId);
    providerId = model?.providerId;
  }
  if (model === undefined || providerId === undefined) return undefined;

  const requestedEffort = input.patch.effort;
  if (requestedEffort !== undefined && !model.thinkingLevels.includes(requestedEffort)) return undefined;
  const effort = requestedEffort
    ?? (input.current.effort !== undefined && model.thinkingLevels.includes(input.current.effort)
      ? input.current.effort
      : compatibleSessionRuntimeEffort(model.thinkingLevels, input.current.effort));
  const fastMode = input.patch.fastMode ?? input.current.fastMode;
  if (input.patch.fastMode === true && (!input.fastModeSupported || model.supportsFastMode !== true)) return undefined;
  return {
    backendId: input.current.backendId,
    providerId,
    modelId,
    ...(effort === undefined ? {} : { effort }),
    fastMode: fastMode && input.fastModeSupported && model.supportsFastMode === true
  };
}

/** Reconcile an axis-only owner or Agent change against a possibly different pending route. */
export function resolveCompatibleSessionRuntimeAxisPatch(input: {
  readonly profile: SessionRuntimeProfile;
  readonly patch: SessionRuntimeAxisPatch;
  readonly models: readonly ProviderModel[];
  readonly fastModeSupported: boolean;
}): SessionRuntimeAxisPatch {
  const model = input.models.find((candidate) =>
    candidate.providerId === input.profile.providerId && candidate.modelId === input.profile.modelId);
  if (model === undefined) return {};
  const effort = input.patch.effort === undefined
    ? undefined
    : model.thinkingLevels.length === 0
      ? null
      : input.patch.effort !== null && model.thinkingLevels.includes(input.patch.effort)
        ? input.patch.effort
        : compatibleSessionRuntimeEffort(model.thinkingLevels, input.patch.effort ?? input.profile.effort);
  const fastMode = input.patch.fastMode === undefined
    ? undefined
    : input.patch.fastMode && input.fastModeSupported && model.supportsFastMode === true;
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(fastMode === undefined ? {} : { fastMode })
  };
}

export function applySessionRuntimeAxisPatch(
  profile: SessionRuntimeProfile,
  patch: SessionRuntimeAxisPatch
): SessionRuntimeProfile {
  const { effort: _effort, ...withoutEffort } = profile;
  return {
    ...(patch.effort === null ? withoutEffort : profile),
    ...(typeof patch.effort === "string" ? { effort: patch.effort } : {}),
    ...(patch.fastMode === undefined ? {} : { fastMode: patch.fastMode })
  };
}

export function sessionRuntimeRouteKey(profile: Pick<SessionRuntimeProfile, "providerId" | "modelId">): string {
  return `${profile.providerId}\0${profile.modelId}`;
}

export function pickSessionRuntimeFallback(input: {
  readonly current: SessionRuntimeProfile;
  readonly models: readonly ProviderModel[];
  readonly availableProviderIds: ReadonlySet<string>;
  readonly explicitDefault?: { readonly providerId: string; readonly modelId: string };
  readonly visitedRoutes: readonly string[];
  readonly currentHop: number;
  readonly maxHops: number;
  readonly fastModeSupported: boolean;
}): SessionRuntimeProfile | undefined {
  if (input.currentHop >= input.maxHops) return undefined;
  const visited = new Set(input.visitedRoutes);
  visited.add(sessionRuntimeRouteKey(input.current));
  const candidates = [
    ...input.models.filter((model) =>
      model.modelId === input.current.modelId
      && model.providerId !== input.current.providerId
      && input.availableProviderIds.has(model.providerId)),
    ...input.models.filter((model) =>
      input.explicitDefault !== undefined
      && model.providerId === input.explicitDefault.providerId
      && model.modelId === input.explicitDefault.modelId
      && input.availableProviderIds.has(model.providerId))
  ];
  for (const candidate of candidates) {
    const route = { providerId: candidate.providerId, modelId: candidate.modelId };
    if (visited.has(sessionRuntimeRouteKey(route))) continue;
    const effort = compatibleSessionRuntimeEffort(candidate.thinkingLevels, input.current.effort);
    return {
      backendId: input.current.backendId,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      ...(effort === undefined ? {} : { effort }),
      fastMode: input.current.fastMode
        && input.fastModeSupported
        && candidate.supportsFastMode === true
    };
  }
  return undefined;
}

const SESSION_RUNTIME_EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

function compatibleSessionRuntimeEffort(
  levels: readonly string[],
  requested: string | undefined
): string | undefined {
  if (levels.length === 0) return undefined;
  if (requested !== undefined && levels.includes(requested)) return requested;
  const requestedRank = requested === undefined
    ? -1
    : SESSION_RUNTIME_EFFORT_ORDER.indexOf(requested as (typeof SESSION_RUNTIME_EFFORT_ORDER)[number]);
  if (requestedRank < 0) return levels[0];
  return [...levels].sort((left, right) => {
    const leftRank = SESSION_RUNTIME_EFFORT_ORDER.indexOf(left as (typeof SESSION_RUNTIME_EFFORT_ORDER)[number]);
    const rightRank = SESSION_RUNTIME_EFFORT_ORDER.indexOf(right as (typeof SESSION_RUNTIME_EFFORT_ORDER)[number]);
    const leftDistance = leftRank < 0 ? Number.MAX_SAFE_INTEGER : Math.abs(leftRank - requestedRank);
    const rightDistance = rightRank < 0 ? Number.MAX_SAFE_INTEGER : Math.abs(rightRank - requestedRank);
    return leftDistance - rightDistance;
  })[0];
}
