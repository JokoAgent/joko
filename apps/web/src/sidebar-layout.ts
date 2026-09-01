import type { SessionView, TargetView, TimelineHistoryCursorView } from "./model.js";

export type SidebarGroupBy = "project" | "flat";
export type SidebarTaskSort = "recency" | "priority";
export type SidebarProjectOrder = "activity" | "custom";
export type SidebarStatus = "active" | "archived" | "all";
export type SidebarLastActivity = "all" | "1d" | "3d" | "7d" | "30d";
export type SidebarMainViewMode = "text" | "list";
export type SidebarPinnedViewMode = "text" | "list" | "card";
export type SidebarSessionInfoField = "time" | "pr" | "worktree" | "tokens" | "cost";
export type SidebarProjectFilter = "all" | readonly string[];

export const SIDEBAR_DIALOGUE_FILTER_ID = "$dialogue";

/** Keep display strategy local to the application, independent of the
 * connected data owner. */
export interface SidebarDisplayPreferences {
  readonly status: SidebarStatus;
  readonly backendId: "all" | string;
  readonly lastActivity: SidebarLastActivity;
  readonly groupBy: SidebarGroupBy;
  readonly groupDialogue: boolean;
  readonly groupDevice: boolean;
  readonly sortBy: SidebarTaskSort;
  readonly projectOrder: SidebarProjectOrder;
  readonly mainViewMode: SidebarMainViewMode;
  readonly pinnedViewMode: SidebarPinnedViewMode;
  /** Selected fields are rendered in this exact user-owned order. */
  readonly sessionInfoFields: readonly SidebarSessionInfoField[];
}

/** Orders and collapse state are data-owner scoped. IDs are opaque service
 * identities; names and paths never enter this browser-owned record. */
export interface SidebarOwnerLayout {
  readonly projectFilter: SidebarProjectFilter;
  readonly manualProjectOrder: readonly string[];
  readonly manualPinnedOrder: readonly string[];
  readonly collapsedProjectIds: readonly string[];
  readonly collapsedDialogue: boolean;
}

export type SidebarOwnerLayouts = Readonly<Record<string, SidebarOwnerLayout>>;

export type SidebarLayout = SidebarDisplayPreferences & SidebarOwnerLayout;

export interface SidebarPriorityContext {
  readonly heldPriorityRanks?: ReadonlyMap<string, number>;
  readonly recentlyViewedAtMs?: ReadonlyMap<string, number>;
  /** The active task consumes normal done/awaiting attention immediately.
   * Suppress it synchronously so the acknowledgement effect cannot expose a
   * transient priority jump; error attention remains viewer-immune. */
  readonly viewedSessionId?: string;
  /** Exact done-attention receipts that survived the local 500ms
   * stability window. Keeping this as a shared projection makes row, rail,
   * sorting, and collapsed-project aggregation observe one transition. */
  readonly visibleDoneAttentionKeys?: ReadonlySet<string>;
}

export interface SidebarViewedPriorityState {
  prevViewedId?: string;
  readonly heldPriorityRanks: Map<string, number>;
  readonly recentlyViewedAtMs: Map<string, number>;
}

interface SidebarDoneAttentionObservation {
  readonly attentionKey: string;
  readonly firstObservedAtMs: number;
  revealed: boolean;
}

export interface SidebarDoneAttentionVisibilityState {
  readonly observations: Map<string, SidebarDoneAttentionObservation>;
}

export interface SidebarDoneAttentionVisibilityProjection {
  readonly visibleAttentionKeys: ReadonlySet<string>;
  readonly nextRevealDelayMs?: number;
}

export type SidebarRightStatus = "error" | "awaiting" | "running" | "done";

export const DEFAULT_SIDEBAR_DISPLAY_PREFERENCES: SidebarDisplayPreferences = {
  status: "active",
  backendId: "all",
  lastActivity: "all",
  groupBy: "project",
  groupDialogue: true,
  groupDevice: true,
  sortBy: "recency",
  projectOrder: "activity",
  mainViewMode: "list",
  pinnedViewMode: "text",
  sessionInfoFields: ["time"]
};

export const DEFAULT_SIDEBAR_OWNER_LAYOUT: SidebarOwnerLayout = {
  projectFilter: "all",
  manualProjectOrder: [],
  manualPinnedOrder: [],
  collapsedProjectIds: [],
  collapsedDialogue: false
};

const MAXIMUM_OWNER_LAYOUTS = 32;
const MAXIMUM_ORDERED_IDENTITIES = 2_048;
const MAXIMUM_IDENTITY_LENGTH = 4_096;
export const SIDEBAR_DONE_ATTENTION_DELAY_MS = 500;
export const SESSION_ATTENTION_ACK_RETRY_BASE_MS = 250;
export const SESSION_ATTENTION_ACK_RETRY_MAX_MS = 4_000;

export function sessionAttentionAcknowledgementRetryDelayMs(failureCount: number): number {
  const boundedFailureCount = Number.isFinite(failureCount)
    ? Math.max(1, Math.min(16, Math.trunc(failureCount)))
    : 1;
  return Math.min(
    SESSION_ATTENTION_ACK_RETRY_MAX_MS,
    SESSION_ATTENTION_ACK_RETRY_BASE_MS * (2 ** (boundedFailureCount - 1))
  );
}

/** Exact-CAS failures wait for a newer authoritative projection; only
 * transport/service availability failures retry the same cursor. */
export function retrySessionAttentionAcknowledgement(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code).toLocaleLowerCase()
    : "";
  return !new Set([
    "revision_conflict",
    "generation_mismatch",
    "invalid_state_transition",
    "not_found",
    "operation_id_conflict",
    "operation_previously_failed"
  ]).has(code);
}

/** Small exact-key state machine used by the App effect. It prevents rerender
 * duplication, backs off transient failures, and makes route/cursor changes
 * invalidate both in-flight completions and scheduled retries. */
export class SessionAttentionAcknowledgementRetryTracker {
  #activeKey: string | undefined;
  #failureCount = 0;
  #phase: "ready" | "inFlight" | "waiting" | "settled" | "blocked" = "ready";

  activate(key: string | undefined): void {
    if (key === this.#activeKey) return;
    this.#activeKey = key;
    this.#failureCount = 0;
    this.#phase = "ready";
  }

  begin(key: string): boolean {
    if (this.#activeKey !== key || this.#phase !== "ready") return false;
    this.#phase = "inFlight";
    return true;
  }

  failed(key: string, error: unknown): number | undefined {
    if (this.#activeKey !== key || this.#phase !== "inFlight") return undefined;
    if (!retrySessionAttentionAcknowledgement(error)) {
      this.#phase = "blocked";
      return undefined;
    }
    this.#failureCount += 1;
    this.#phase = "waiting";
    return sessionAttentionAcknowledgementRetryDelayMs(this.#failureCount);
  }

  release(key: string): boolean {
    if (this.#activeKey !== key || this.#phase !== "waiting") return false;
    this.#phase = "ready";
    return true;
  }

  succeeded(key: string): void {
    if (this.#activeKey === key && this.#phase === "inFlight") this.#phase = "settled";
  }
}

export function createSidebarDoneAttentionVisibilityState(): SidebarDoneAttentionVisibilityState {
  return { observations: new Map() };
}

/** The done debounce uses local receipt time, not a comparison between a
 * service clock and a browser clock. A new exact cursor starts one monotonic
 * 500ms window; a running/cleared/newer projection cancels the old window. */
export function reconcileSidebarDoneAttentionVisibility(
  state: SidebarDoneAttentionVisibilityState,
  sessions: readonly SessionView[],
  monotonicNowMs: number
): SidebarDoneAttentionVisibilityProjection {
  if (!Number.isFinite(monotonicNowMs)) throw new Error("Sidebar attention clock must be finite.");
  const retainedSessionIds = new Set<string>();
  const visibleAttentionKeys = new Set<string>();
  let nextRevealDelayMs: number | undefined;
  for (const session of sessions) {
    const attention = session.attention;
    if (
      attention?.unread !== true ||
      attention.kind !== "done" ||
      session.state === "running" ||
      session.state === "retrying" ||
      session.state === "waiting"
    ) {
      state.observations.delete(session.id);
      continue;
    }
    retainedSessionIds.add(session.id);
    const attentionKey = sidebarDoneAttentionKey(session.id, attention.subjectCursor.opaqueToken);
    const previous = state.observations.get(session.id);
    const observation = previous?.attentionKey === attentionKey
      ? previous
      : { attentionKey, firstObservedAtMs: monotonicNowMs, revealed: false };
    state.observations.set(session.id, observation);
    const elapsedMs = Math.max(0, monotonicNowMs - observation.firstObservedAtMs);
    if (!observation.revealed && elapsedMs >= SIDEBAR_DONE_ATTENTION_DELAY_MS) {
      observation.revealed = true;
    }
    if (observation.revealed) {
      visibleAttentionKeys.add(attentionKey);
      continue;
    }
    const delayMs = Math.max(1, Math.ceil(SIDEBAR_DONE_ATTENTION_DELAY_MS - elapsedMs));
    nextRevealDelayMs = nextRevealDelayMs === undefined
      ? delayMs
      : Math.min(nextRevealDelayMs, delayMs);
  }
  for (const sessionId of state.observations.keys()) {
    if (!retainedSessionIds.has(sessionId)) state.observations.delete(sessionId);
  }
  return {
    visibleAttentionKeys,
    ...(nextRevealDelayMs === undefined ? {} : { nextRevealDelayMs })
  };
}

export function sidebarDoneAttentionKey(sessionId: string, cursorToken: string): string {
  return `${sessionId}\u0000${cursorToken}`;
}

export function normalizeSidebarOwnerLayouts(value: unknown): SidebarOwnerLayouts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, SidebarOwnerLayout> = {};
  for (const [ownerId, candidate] of Object.entries(value).slice(0, MAXIMUM_OWNER_LAYOUTS)) {
    if (!validIdentity(ownerId)) continue;
    result[ownerId] = normalizeSidebarOwnerLayout(candidate);
  }
  return result;
}

export function normalizeSidebarOwnerLayout(value: unknown): SidebarOwnerLayout {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    projectFilter: normalizeSidebarProjectFilter(record["projectFilter"]),
    manualProjectOrder: normalizeIdentityList(record["manualProjectOrder"]),
    manualPinnedOrder: normalizeIdentityList(record["manualPinnedOrder"]),
    collapsedProjectIds: normalizeIdentityList(record["collapsedProjectIds"]),
    collapsedDialogue: record["collapsedDialogue"] === true
  };
}

export function normalizeSidebarDisplayPreferences(value: unknown): SidebarDisplayPreferences {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    status: record["status"] === "archived" || record["status"] === "all" ? record["status"] : "active",
    backendId: validIdentity(record["backendId"]) ? record["backendId"] : "all",
    lastActivity: record["lastActivity"] === "1d" || record["lastActivity"] === "3d"
      || record["lastActivity"] === "7d" || record["lastActivity"] === "30d"
      ? record["lastActivity"]
      : "all",
    groupBy: record["groupBy"] === "flat" ? "flat" : "project",
    groupDialogue: record["groupDialogue"] !== false,
    groupDevice: record["groupDevice"] !== false,
    sortBy: record["sortBy"] === "priority" ? "priority" : "recency",
    projectOrder: record["projectOrder"] === "custom" ? "custom" : "activity",
    mainViewMode: record["mainViewMode"] === "text" ? "text" : "list",
    pinnedViewMode: record["pinnedViewMode"] === "list" || record["pinnedViewMode"] === "card"
      ? record["pinnedViewMode"]
      : "text",
    sessionInfoFields: normalizeSidebarSessionInfoFields(record["sessionInfoFields"])
  };
}

export function normalizeSidebarSessionInfoFields(value: unknown): readonly SidebarSessionInfoField[] {
  if (!Array.isArray(value)) return DEFAULT_SIDEBAR_DISPLAY_PREFERENCES.sessionInfoFields;
  const allowed = new Set<SidebarSessionInfoField>(["time", "pr", "worktree", "tokens", "cost"]);
  const seen = new Set<SidebarSessionInfoField>();
  const result: SidebarSessionInfoField[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !allowed.has(candidate as SidebarSessionInfoField)) continue;
    const field = candidate as SidebarSessionInfoField;
    if (seen.has(field)) continue;
    seen.add(field);
    result.push(field);
  }
  return result;
}

export function normalizeSidebarProjectFilter(value: unknown): SidebarProjectFilter {
  if (value === "all") return "all";
  const ids = normalizeIdentityList(value);
  return ids.length === 0 ? "all" : ids;
}

export function toggleSidebarProjectFilter(
  filter: SidebarProjectFilter,
  projectId: string
): SidebarProjectFilter {
  if (!validIdentity(projectId)) return filter;
  if (filter === "all") return [projectId];
  const normalized = normalizeSidebarProjectFilter(filter);
  if (normalized === "all") return [projectId];
  const next = normalized.includes(projectId)
    ? normalized.filter((candidate) => candidate !== projectId)
    : [...normalized, projectId];
  return next.length === 0 ? "all" : next;
}

export function sidebarContentFilterCount(layout: Pick<
  SidebarLayout,
  "status" | "backendId" | "lastActivity" | "projectFilter"
>): number {
  return Number(layout.status !== "active")
    + Number(layout.backendId !== "all")
    + Number(layout.lastActivity !== "all")
    + Number(layout.projectFilter !== "all");
}

export function filterSidebarSessions(
  sessions: readonly SessionView[],
  layout: Pick<SidebarLayout, "backendId" | "lastActivity" | "projectFilter">,
  nowMs: number
): readonly SessionView[] {
  if (!Number.isFinite(nowMs)) throw new Error("Sidebar filter clock must be finite.");
  const projectIds = layout.projectFilter === "all" ? undefined : new Set(layout.projectFilter);
  const cutoff = sidebarLastActivityCutoff(layout.lastActivity, nowMs);
  return sessions.filter((session) => {
    if (layout.backendId !== "all" && session.backendId !== layout.backendId) return false;
    if (cutoff !== undefined && session.updatedAt < cutoff) return false;
    if (projectIds === undefined) return true;
    return session.projectId === undefined
      ? projectIds.has(SIDEBAR_DIALOGUE_FILTER_ID)
      : projectIds.has(session.projectId);
  });
}

export function sidebarLastActivityCutoff(
  lastActivity: SidebarLastActivity,
  nowMs: number
): number | undefined {
  if (lastActivity === "all") return undefined;
  const days = lastActivity === "1d" ? 1 : lastActivity === "3d" ? 3 : lastActivity === "7d" ? 7 : 30;
  return nowMs - days * 24 * 60 * 60 * 1_000;
}

/** Re-selecting a field moves it to the end, matching the visible information order. */
export function toggleSidebarSessionInfoField(
  fields: readonly SidebarSessionInfoField[],
  field: SidebarSessionInfoField
): readonly SidebarSessionInfoField[] {
  const normalized = normalizeSidebarSessionInfoFields(fields);
  return normalized.includes(field)
    ? normalized.filter((candidate) => candidate !== field)
    : [...normalized, field];
}

export function withSidebarDisplayPreferences(
  preferences: SidebarDisplayPreferences,
  patch: Partial<SidebarDisplayPreferences>
): SidebarDisplayPreferences {
  return normalizeSidebarDisplayPreferences({ ...preferences, ...patch });
}

export function sidebarOwnerLayoutFor(layouts: SidebarOwnerLayouts, ownerId: string | undefined): SidebarOwnerLayout {
  if (ownerId === undefined || !validIdentity(ownerId)) return DEFAULT_SIDEBAR_OWNER_LAYOUT;
  return layouts[ownerId] ?? DEFAULT_SIDEBAR_OWNER_LAYOUT;
}

export function withSidebarOwnerLayout(
  layouts: SidebarOwnerLayouts,
  ownerId: string,
  patch: Partial<SidebarOwnerLayout>
): SidebarOwnerLayouts {
  if (!validIdentity(ownerId)) return layouts;
  const nextLayout = normalizeSidebarOwnerLayout({
    ...(layouts[ownerId] ?? DEFAULT_SIDEBAR_OWNER_LAYOUT),
    ...patch
  });
  const entries = Object.entries(layouts).filter(([candidate]) => candidate !== ownerId);
  // Keep the active owner even when malformed IndexedDB data was already over
  // the bound. Most-recently changed owners stay at the end of insertion order.
  const retained = entries.slice(Math.max(0, entries.length - (MAXIMUM_OWNER_LAYOUTS - 1)));
  return Object.fromEntries([...retained, [ownerId, nextLayout]]);
}

/** Reconciles a persisted manual order against the complete current catalogue.
 * Existing active identities keep their rank, stale identities are removed,
 * and newly discovered identities append in the supplied discovery order. */
export function normalizeManualSidebarOrder(
  previous: readonly string[],
  activeIds: readonly string[]
): readonly string[] {
  const active = new Set(normalizeIdentityList(activeIds));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of previous) {
    if (!active.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of activeIds) {
    if (!active.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Filtered-drag invariant: only visible slots are rewritten. Hidden
 * projects/tasks keep their exact full-order positions across search, archive,
 * project filters, and later restoration. */
export function mergeVisibleSidebarReorder(
  currentFullOrder: readonly string[],
  visibleNewOrder: readonly string[]
): readonly string[] {
  const visible = new Set(visibleNewOrder);
  const queue = [...visibleNewOrder];
  const result: string[] = [];
  for (const id of currentFullOrder) {
    if (!visible.has(id)) {
      result.push(id);
      continue;
    }
    result.push(queue.shift() ?? id);
  }
  result.push(...queue);
  return result;
}

export function manualSidebarOrderAfterVisibleReorder(
  previous: readonly string[],
  allActiveIds: readonly string[],
  visibleNewOrder: readonly string[]
): readonly string[] {
  return mergeVisibleSidebarReorder(
    normalizeManualSidebarOrder(previous, allActiveIds),
    normalizeIdentityList(visibleNewOrder)
  );
}

export function promoteNewPinnedSidebarIds(
  previous: readonly string[],
  allPinnedIds: readonly string[],
  newlyPinnedIds: readonly string[]
): readonly string[] {
  const normalized = normalizeManualSidebarOrder(previous, allPinnedIds);
  const newlyPinned = new Set(newlyPinnedIds);
  return [
    ...allPinnedIds.filter((id, index) => newlyPinned.has(id) && allPinnedIds.indexOf(id) === index),
    ...normalized.filter((id) => !newlyPinned.has(id))
  ];
}

export function sortSidebarSessions(
  sessions: readonly SessionView[],
  sortBy: SidebarTaskSort,
  priorityContext: SidebarPriorityContext = {}
): readonly SessionView[] {
  return [...sessions].sort((left, right) => {
    if (sortBy === "priority") {
      const priority = sidebarSessionPriority(left, priorityContext) - sidebarSessionPriority(right, priorityContext);
      if (priority !== 0) return priority;
      return sidebarPriorityRecencyMs(right, priorityContext) - sidebarPriorityRecencyMs(left, priorityContext)
        || left.id.localeCompare(right.id);
    }
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  });
}

export function sortSidebarTargets(
  targets: readonly TargetView[],
  sessions: readonly SessionView[],
  sortBy: SidebarTaskSort,
  projectOrder: SidebarProjectOrder,
  manualProjectOrder: readonly string[],
  priorityContext: SidebarPriorityContext = {}
): readonly TargetView[] {
  const activeTargetIds = targets
    .filter((target) => sessions.some((session) => session.projectId === target.id))
    .map((target) => target.id);
  if (projectOrder === "custom") {
    const rank = new Map(normalizeManualSidebarOrder(manualProjectOrder, activeTargetIds).map((id, index) => [id, index]));
    return [...targets].sort((left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id));
  }
  const summaries = new Map(targets.map((target) => {
    const owned = sessions.filter((session) => session.projectId === target.id);
    return [target.id, {
      priority: owned.length === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.min(...owned.map((session) => sidebarSessionPriority(session, priorityContext))),
      activity: owned.reduce(
        (latest, session) => Math.max(
          latest,
          sortBy === "priority" ? sidebarPriorityRecencyMs(session, priorityContext) : session.updatedAt
        ),
        0
      )
    }];
  }));
  return [...targets].sort((left, right) => {
    const leftSummary = summaries.get(left.id)!;
    const rightSummary = summaries.get(right.id)!;
    if (sortBy === "priority" && leftSummary.priority !== rightSummary.priority) {
      return leftSummary.priority - rightSummary.priority;
    }
    return rightSummary.activity - leftSummary.activity
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id);
  });
}

export function sidebarSessionNaturalPriority(
  session: SessionView,
  context: Pick<SidebarPriorityContext, "viewedSessionId" | "visibleDoneAttentionKeys"> = {}
): number {
  const attention = visibleSidebarAttention(session, context);
  if (attention?.unread === true &&
    (attention.kind === "awaiting" || attention.kind === "error")) return 0;
  if (attention?.kind === "done" && attention.unread) return 1;
  if (session.state === "running" || session.state === "retrying") return 2;
  return 3;
}

export function sidebarSessionPriority(
  session: SessionView,
  context: SidebarPriorityContext = {}
): number {
  const natural = sidebarSessionNaturalPriority(session, context);
  const held = context.heldPriorityRanks?.get(session.id);
  return held === undefined ? natural : Math.min(natural, held);
}

export function sidebarPriorityRecencyMs(
  session: SessionView,
  context: SidebarPriorityContext = {}
): number {
  if (sidebarSessionNaturalPriority(session, context) !== 3) return session.updatedAt;
  return Math.max(session.updatedAt, context.recentlyViewedAtMs?.get(session.id) ?? 0);
}

export function createSidebarViewedPriorityState(): SidebarViewedPriorityState {
  return { heldPriorityRanks: new Map(), recentlyViewedAtMs: new Map() };
}

export function holdSidebarViewedPriorityRank(
  state: SidebarViewedPriorityState,
  session: SessionView,
  context: Pick<SidebarPriorityContext, "viewedSessionId" | "visibleDoneAttentionKeys"> = {}
): void {
  const natural = sidebarSessionNaturalPriority(session, context);
  const held = state.heldPriorityRanks.get(session.id);
  state.heldPriorityRanks.set(session.id, held === undefined ? natural : Math.min(held, natural));
}

export function advanceSidebarViewedPriority(
  state: SidebarViewedPriorityState,
  viewedSession: SessionView | undefined,
  nowMs: number,
  context: Pick<SidebarPriorityContext, "visibleDoneAttentionKeys"> = {}
): SidebarViewedPriorityState {
  const newlyViewed = viewedSession !== undefined && state.prevViewedId !== viewedSession.id;
  if (state.prevViewedId !== undefined && state.prevViewedId !== viewedSession?.id) {
    if (state.heldPriorityRanks.get(state.prevViewedId) === 1) {
      state.recentlyViewedAtMs.set(state.prevViewedId, nowMs);
    }
    state.heldPriorityRanks.delete(state.prevViewedId);
  }
  if (viewedSession !== undefined) {
    holdSidebarViewedPriorityRank(
      state,
      viewedSession,
      newlyViewed ? context : { ...context, viewedSessionId: viewedSession.id }
    );
  }
  state.prevViewedId = viewedSession?.id;
  return state;
}

export function viewerAttentionCursor(session: SessionView): TimelineHistoryCursorView | undefined {
  const attention = session.attention;
  return attention?.unread === true && attention.kind !== "error"
    ? attention.attentionCursor
    : undefined;
}

export function viewerAttentionCursorWhenHistoryReady(
  session: SessionView,
  snapshotGeneration: bigint,
  history: {
    readonly sessionId: string;
    readonly generation: bigint;
    readonly initialized: boolean;
    readonly loading: boolean;
    readonly error?: string;
  } | undefined
): TimelineHistoryCursorView | undefined {
  if (
    history?.sessionId !== session.id ||
    history.generation !== snapshotGeneration ||
    !history.initialized ||
    history.loading ||
    history.error !== undefined
  ) return undefined;
  return viewerAttentionCursor(session);
}

export function visibleSidebarAttention(
  session: SessionView,
  context: Pick<SidebarPriorityContext, "viewedSessionId" | "visibleDoneAttentionKeys"> = {}
): SessionView["attention"] {
  const attention = session.attention;
  if (attention?.unread !== true) return undefined;
  if (context.viewedSessionId === session.id && attention.kind !== "error") return undefined;
  if (attention.kind === "done" && context.visibleDoneAttentionKeys !== undefined) {
    const key = sidebarDoneAttentionKey(session.id, attention.subjectCursor.opaqueToken);
    if (!context.visibleDoneAttentionKeys.has(key)) return undefined;
  }
  return attention;
}

export function sidebarSessionIndicatorState(
  session: SessionView,
  context: Pick<SidebarPriorityContext, "viewedSessionId" | "visibleDoneAttentionKeys"> = {}
): SidebarRightStatus | undefined {
  const attention = visibleSidebarAttention(session, context);
  if (attention?.kind === "error") return "error";
  if (attention?.kind === "awaiting") return "awaiting";
  // Right-slot status is intentionally independent from sort rank: a live
  // run outranks a delayed/stale completion on the same transient projection.
  if (session.state === "running" || session.state === "retrying") return "running";
  if (attention?.kind === "done") return "done";
  return undefined;
}

export function sidebarGroupIndicatorState(
  sessions: readonly SessionView[],
  context: Pick<SidebarPriorityContext, "viewedSessionId" | "visibleDoneAttentionKeys"> = {}
): SidebarRightStatus | undefined {
  const rank: Readonly<Record<SidebarRightStatus, number>> = {
    error: 0,
    awaiting: 1,
    running: 2,
    done: 3
  };
  return sessions
    .map((session) => ({ status: sidebarSessionIndicatorState(session, context), updatedAt: session.updatedAt }))
    .filter((candidate): candidate is { readonly status: SidebarRightStatus; readonly updatedAt: number } => candidate.status !== undefined)
    .sort((left, right) => rank[left.status] - rank[right.status] || right.updatedAt - left.updatedAt)[0]?.status;
}

export function sameSidebarOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeIdentityList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAXIMUM_ORDERED_IDENTITIES)) {
    if (!validIdentity(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAXIMUM_IDENTITY_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
