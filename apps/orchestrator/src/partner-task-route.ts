import type { UsageSnapshot } from "@joko/core";
import type { PartnerModelRouteRecord } from "@joko/store";
import { decideProviderGroupFailure, type ProviderGroupFailureSignals } from "./provider-group-failure-policy.js";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";

type UsageReading = Pick<UsageSnapshot, "contextTokens" | "contextWindow"> | undefined;
const positive = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const routeKey = (route: SessionRuntimeProfile) => `${route.backendId}\0${route.providerId}\0${route.modelId}`;

/** Placeholder zero and durable totals alone never prove shrink safety.
 * A closed runtime reading survives a fresh attachment's placeholder usage. */
export function partnerTaskContextUsage(live: UsageReading, closed: UsageReading, durable: UsageReading = undefined) {
  const tokens = Math.max(positive(live?.contextTokens) ?? 0, positive(closed?.contextTokens) ?? 0);
  return { contextTokens: tokens > 0 ? Math.max(tokens, positive(durable?.contextTokens) ?? 0) : null,
    contextWindow: positive(live?.contextWindow) ?? positive(closed?.contextWindow) };
}

/** A suggestion authorizes no retry and never substitutes the Partner's first
 * route for an owner-selected model outside the frozen chain. */
export function suggestPartnerTaskRoute(input: {
  readonly chain: readonly PartnerModelRouteRecord[];
  readonly current: SessionRuntimeProfile | undefined;
  readonly failure: ProviderGroupFailureSignals | undefined;
  readonly visitedRoutes: readonly string[];
  readonly contextTokens: number | null;
  readonly currentContextWindow: number | null;
  readonly available: (route: PartnerModelRouteRecord) => boolean;
  readonly windowOf: (route: PartnerModelRouteRecord) => number | undefined;
}): PartnerModelRouteRecord | undefined {
  if (!input.current || decideProviderGroupFailure(input.failure, "run").action !== "switch") return undefined;
  const index = input.chain.findIndex(route => routeKey(route) === routeKey(input.current!));
  if (index < 0) return undefined;
  const visited = new Set([...input.visitedRoutes, routeKey(input.current)]);
  return input.chain.slice(index + 1).find(route => {
    if (visited.has(routeKey(route)) || !input.available(route)) return false;
    const targetWindow = positive(input.windowOf(route));
    if (targetWindow === null) return true;
    if (input.currentContextWindow !== null && targetWindow >= input.currentContextWindow) return true;
    return input.contextTokens !== null && input.contextTokens / targetWindow < 0.7;
  });
}
