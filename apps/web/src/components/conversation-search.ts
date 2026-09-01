import type {
  SessionMessageSearchMatchView,
  SessionMessageSearchScopeView,
  SessionView,
  TargetView
} from "../model.js";
import type { MessageSearchSortPreference } from "../local-state.js";
import { fuzzySidebarMatch, type SidebarFuzzyMatch } from "./coding-ui-behavior.js";

export type ConversationSearchSort = MessageSearchSortPreference;
export const CONVERSATION_SEARCH_RESULT_LIMIT = 24;

export type ConversationSearchStatusFilter = "active" | "archived" | "all";
export type ConversationSearchLastActivityFilter = "1d" | "3d" | "7d" | "30d" | "all";

/**
 * Capability-neutral local filters for conversation search.
 * Backends and targets are discovered at runtime instead of being named here.
 */
export interface ConversationSearchFilters {
  readonly status?: ConversationSearchStatusFilter;
  /** A single dynamically discovered backend, or every backend. */
  readonly backendId?: string | "all";
  readonly lastActivity?: ConversationSearchLastActivityFilter;
  /** Dynamically discovered target ids. An empty selection matches nothing. */
  readonly targetIds?: readonly string[] | "all";
}

export const ALL_CONVERSATION_SEARCH_FILTERS = {
  status: "all",
  backendId: "all",
  lastActivity: "all",
  targetIds: "all"
} as const satisfies ConversationSearchFilters;

const DAY_MS = 24 * 60 * 60 * 1_000;
const LAST_ACTIVITY_DAY_COUNTS: Readonly<Record<Exclude<ConversationSearchLastActivityFilter, "all">, number>> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30
};

export interface ConversationSearchResult {
  readonly session: SessionView;
  readonly target?: TargetView;
  readonly titleMatch: SidebarFuzzyMatch | null;
  readonly hits: readonly SessionMessageSearchMatchView[];
  readonly score: number;
}

export interface ConversationSearchOption {
  readonly key: string;
  readonly kind: "session" | "message" | "expand";
  readonly result: ConversationSearchResult;
  readonly hit?: SessionMessageSearchMatchView;
}

export type ConversationSearchActivation =
  | { readonly kind: "expand"; readonly sessionId: string }
  | { readonly kind: "message"; readonly hit: SessionMessageSearchMatchView }
  | { readonly kind: "session"; readonly session: SessionView };

/** A parent result row opens its best content hit when one exists. */
export function resolveConversationSearchActivation(option: ConversationSearchOption): ConversationSearchActivation {
  if (option.kind === "expand") return { kind: "expand", sessionId: option.result.session.id };
  const hit = option.kind === "message" ? option.hit : option.result.hits[0];
  return hit === undefined
    ? { kind: "session", session: option.result.session }
    : { kind: "message", hit };
}

/**
 * Builds the shared conversation result projection. The service
 * owns durable message matching; task/project title matching stays local so a
 * task can still be opened when only its visible title matches.
 */
export function projectConversationSearchResults(
  sessions: readonly SessionView[],
  targets: readonly TargetView[],
  matches: readonly SessionMessageSearchMatchView[],
  query: string,
  scope: SessionMessageSearchScopeView,
  sort: ConversationSearchSort,
  maximumResults = CONVERSATION_SEARCH_RESULT_LIMIT,
  filters: ConversationSearchFilters = ALL_CONVERSATION_SEARCH_FILTERS,
  nowMs = Date.now()
): readonly ConversationSearchResult[] {
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const normalizedFilters = normalizeConversationSearchFilters(filters, nowMs);
  const matchingSessions = sessions.filter((session) =>
    sessionMatchesSearchScope(session, scope) && sessionMatchesConversationSearchFilters(session, normalizedFilters));
  const sessionById = new Map(matchingSessions.map((session) => [session.id, session]));
  const hitsBySession = new Map<string, SessionMessageSearchMatchView[]>();
  const seenHits = new Set<string>();
  for (const match of matches) {
    if (!sessionById.has(match.sessionId)) continue;
    const identity = `${match.sessionId}:${match.eventId}`;
    if (seenHits.has(identity)) continue;
    seenHits.add(identity);
    const values = hitsBySession.get(match.sessionId) ?? [];
    values.push(match);
    hitsBySession.set(match.sessionId, values);
  }

  const results = matchingSessions.flatMap((session): ConversationSearchResult[] => {
    const target = targetById.get(session.targetId);
    // Search the visible task title only. Project names remain
    // metadata and an explicit filter; matching them here would return every
    // task in a project for a project-name query.
    const titleMatch = fuzzySidebarMatch(session.name, "", query);
    const allHits = (hitsBySession.get(session.id) ?? [])
      .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt || left.eventId.localeCompare(right.eventId));
    if (titleMatch === null && allHits.length === 0) return [];
    const score = Math.max(titleMatch?.score ?? Number.NEGATIVE_INFINITY, allHits[0]?.score ?? Number.NEGATIVE_INFINITY);
    return [{
      session,
      ...(target === undefined ? {} : { target }),
      titleMatch,
      hits: allHits,
      score
    }];
  });

  results.sort((left, right) => {
    if (sort === "activityAsc") {
      return left.session.updatedAt - right.session.updatedAt || relevanceOrder(left, right);
    }
    if (sort === "activityDesc") {
      return right.session.updatedAt - left.session.updatedAt || relevanceOrder(left, right);
    }
    return relevanceOrder(left, right);
  });
  return results.slice(0, Math.max(0, maximumResults));
}

export function flattenConversationSearchOptions(
  results: readonly ConversationSearchResult[],
  expandedSessionIds: ReadonlySet<string> = new Set(),
  maximumCollapsedHits = 3
): readonly ConversationSearchOption[] {
  return results.flatMap((result) => {
    const visibleHits = expandedSessionIds.has(result.session.id)
      ? result.hits
      : result.hits.slice(0, Math.max(0, maximumCollapsedHits));
    const hiddenHitCount = result.hits.length - visibleHits.length;
    return [
      { key: `session:${result.session.id}`, kind: "session" as const, result },
      ...visibleHits.map((hit) => ({
      key: `message:${hit.sessionId}:${hit.eventId}`,
      kind: "message" as const,
      result,
      hit
      })),
      ...(hiddenHitCount === 0 ? [] : [{
        key: `expand:${result.session.id}`,
        kind: "expand" as const,
        result
      }])
    ];
  });
}

export function moveConversationSearchSelection(
  currentIndex: number,
  optionCount: number,
  direction: "next" | "previous" | "first" | "last"
): number {
  if (optionCount <= 0) return -1;
  if (direction === "first") return 0;
  if (direction === "last") return optionCount - 1;
  if (currentIndex < 0 || currentIndex >= optionCount) return direction === "previous" ? optionCount - 1 : 0;
  return direction === "next"
    ? (currentIndex + 1) % optionCount
    : (currentIndex - 1 + optionCount) % optionCount;
}

/** Literal per-token highlighting for keyword result rows. */
export function conversationSearchHighlightRanges(text: string, query: string): readonly { readonly start: number; readonly end: number }[] {
  const tokens = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .sort((left, right) => right.length - left.length);
  if (tokens.length === 0) return [];
  const candidate = text.toLocaleLowerCase();
  const ranges: { start: number; end: number }[] = [];
  for (const token of tokens) {
    const needle = token.toLocaleLowerCase();
    let start = candidate.indexOf(needle);
    while (start >= 0) {
      const next = { start, end: start + token.length };
      if (!ranges.some((range) => range.start < next.end && next.start < range.end)) ranges.push(next);
      start = candidate.indexOf(needle, start + needle.length);
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function sessionMatchesSearchScope(session: SessionView, scope: SessionMessageSearchScopeView): boolean {
  if (scope.kind === "owner") return true;
  if (scope.kind === "target") return session.targetId === scope.targetId;
  return session.id === scope.sessionId;
}

interface NormalizedConversationSearchFilters {
  readonly status: ConversationSearchStatusFilter;
  readonly backendId?: string;
  readonly activityCutoff?: number;
  readonly targetIds?: ReadonlySet<string>;
}

function normalizeConversationSearchFilters(
  filters: ConversationSearchFilters,
  nowMs: number
): NormalizedConversationSearchFilters {
  const lastActivity = filters.lastActivity ?? "all";
  return {
    status: filters.status ?? "all",
    ...(filters.backendId === undefined || filters.backendId === "all"
      ? {}
      : { backendId: filters.backendId }),
    ...(lastActivity === "all"
      ? {}
      : { activityCutoff: nowMs - LAST_ACTIVITY_DAY_COUNTS[lastActivity] * DAY_MS }),
    ...(filters.targetIds === undefined || filters.targetIds === "all"
      ? {}
      : { targetIds: new Set(filters.targetIds) })
  };
}

function sessionMatchesConversationSearchFilters(
  session: SessionView,
  filters: NormalizedConversationSearchFilters
): boolean {
  if (filters.status === "active" && session.archived) return false;
  if (filters.status === "archived" && !session.archived) return false;
  if (filters.backendId !== undefined && session.backendId !== filters.backendId) return false;
  if (filters.activityCutoff !== undefined && session.updatedAt < filters.activityCutoff) return false;
  if (filters.targetIds !== undefined && !filters.targetIds.has(session.targetId)) return false;
  return true;
}

function relevanceOrder(left: ConversationSearchResult, right: ConversationSearchResult): number {
  return Number(right.titleMatch !== null) - Number(left.titleMatch !== null) ||
    right.score - left.score ||
    right.session.updatedAt - left.session.updatedAt ||
    left.session.id.localeCompare(right.session.id);
}
