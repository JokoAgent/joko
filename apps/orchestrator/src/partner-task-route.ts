import type { UsageSnapshot } from "@joko/core";
import type { PartnerModelRouteRecord } from "@joko/store";
import { decideProviderGroupFailure, type ProviderGroupFailureSignals } from "./provider-group-failure-policy.js";
import { sessionRuntimeRouteKey, type SessionRuntimeProfile } from "./session-runtime-control.js";

type UsageReading = Pick<UsageSnapshot, "contextTokens" | "contextWindow"> | undefined;
const positive = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
export interface PartnerFallbackInput {
  readonly sessionId: string;
  readonly current: SessionRuntimeProfile;
  readonly visitedRoutes: readonly string[];
  readonly currentHop: number;
}
export type PartnerGroupRoutes = (groupId: string) => readonly SessionRuntimeProfile[] | undefined;

export function nextPartnerFallback(saved: readonly PartnerModelRouteRecord[], input: PartnerFallbackInput, groupRoutes?: PartnerGroupRoutes): SessionRuntimeProfile | undefined {
  const chain: { profile: SessionRuntimeProfile; key: string; groupId?: string }[] = [];
  const seen = new Set<string>();
  for (const { taskModelGroupId, ...exact } of saved) {
    const members = taskModelGroupId === undefined ? undefined : groupRoutes?.(taskModelGroupId);
    for (const profile of [...(members ?? []), exact]) {
      const key = sessionRuntimeRouteKey(profile);
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push({ profile, key, groupId: members === undefined ? undefined : taskModelGroupId });
    }
  }
  const current = chain.findIndex(route => route.key === sessionRuntimeRouteKey(input.current));
  const outsideGroup = current < 0 && saved.some(route => route.taskModelGroupId !== undefined);
  if (input.currentHop >= chain.length - (outsideGroup ? 0 : 1)) return undefined;
  const groupId = chain[current]?.groupId;
  let start = current, end = current + 1;
  if (groupId !== undefined) {
    while (start > 0 && chain[start - 1]!.groupId === groupId) start--;
    while (end < chain.length && chain[end]!.groupId === groupId) end++;
  }
  const order = [...chain.slice(current + 1, end), ...chain.slice(start, current), ...chain.slice(end)];
  return order.find(route => !input.visitedRoutes.includes(route.key))?.profile;
}

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
  const index = input.chain.findIndex(route => sessionRuntimeRouteKey(route) === sessionRuntimeRouteKey(input.current!));
  if (index < 0) return undefined;
  const visited = new Set([...input.visitedRoutes, sessionRuntimeRouteKey(input.current)]);
  return input.chain.slice(index + 1).find(route => {
    if (visited.has(sessionRuntimeRouteKey(route)) || !input.available(route)) return false;
    const targetWindow = positive(input.windowOf(route));
    if (targetWindow === null) return true;
    if (input.currentContextWindow !== null && targetWindow >= input.currentContextWindow) return true;
    return input.contextTokens !== null && input.contextTokens / targetWindow < 0.7;
  });
}
