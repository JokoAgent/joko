import { SessionAttentionKind, SessionState, WorkspaceKind, type Session, type Snapshot } from "@joko/contracts";
import { safeWindowRect, windowDivision, type MobileWindowGeometry } from "./mobile-window-geometry";

export type MobileHomeStatusFilter = "active" | "archived" | "all";
export type MobileHomeSearchSort = "relevance" | "activityDesc" | "activityAsc";
export const MOBILE_HOME_ACTIVITY_FILTERS = ["all", "1d", "3d", "7d", "30d"] as const;
export const MOBILE_HOME_TASK_SORTS = ["activity", "created", "priority"] as const;
export const MOBILE_HOME_PROJECT_PREVIEW_LIMIT = 5;
export type MobileHomeActivityFilter = typeof MOBILE_HOME_ACTIVITY_FILTERS[number];
export type MobileHomeTaskSort = typeof MOBILE_HOME_TASK_SORTS[number];

export interface MobileHomeDisplayPreferences {
  readonly projectFilter: "all" | readonly string[];
  readonly backendId: string | null;
  readonly lastActivity: MobileHomeActivityFilter;
  readonly sortBy: MobileHomeTaskSort;
  readonly projectOrder: "activity" | "manual";
  readonly manualProjectOrder: readonly string[];
}

export const DEFAULT_MOBILE_HOME_DISPLAY: MobileHomeDisplayPreferences = {
  projectFilter: "all",
  backendId: null,
  lastActivity: "all",
  sortBy: "activity",
  projectOrder: "activity",
  manualProjectOrder: []
};

export function hasMobileHomeDisplayFilters(display: MobileHomeDisplayPreferences): boolean {
  return display.projectFilter !== "all" || display.backendId !== null || display.lastActivity !== "all";
}

const MOBILE_HOME_ACTIVITY_DAYS: Readonly<Record<Exclude<MobileHomeActivityFilter, "all">, number>> = {
  "1d": 1, "3d": 3, "7d": 7, "30d": 30
};

export interface MobileHomeSearchMatch {
  readonly sessionId: string;
  readonly eventId?: string;
}

export interface MobileHomeSessionItem {
  readonly session: Session;
  readonly navigationName: string;
  readonly groupKind: "dialogue" | "project";
  readonly groupKey: string;
  readonly groupTitle: string;
}

export interface MobileHomeSection {
  readonly key: string;
  readonly kind: "pinned" | "dialogue" | "project" | "search";
  readonly title: string;
  readonly items: readonly MobileHomeSessionItem[];
}

export interface BuildMobileHomeSectionsOptions {
  readonly snapshot: Snapshot | undefined;
  readonly statusFilter: MobileHomeStatusFilter;
  readonly query: string;
  readonly searchSort?: MobileHomeSearchSort;
  readonly display?: MobileHomeDisplayPreferences;
  readonly projectId?: string;
  readonly now?: number;
  readonly messageSessionIds?: ReadonlySet<string>;
  readonly labels: {
    readonly dialogue: string;
    readonly project: string;
    readonly pinned: string;
  };
}

export function buildMobileHomeSections(options: BuildMobileHomeSectionsOptions): MobileHomeSection[] {
  const snapshot = options.snapshot;
  if (!snapshot) return [];
  const normalizedQuery = options.query.trim().toLocaleLowerCase();
  const display = options.display ?? DEFAULT_MOBILE_HOME_DISPLAY;
  const cutoff = display.lastActivity === "all" ? undefined
    : (options.now ?? Date.now()) - MOBILE_HOME_ACTIVITY_DAYS[display.lastActivity] * 86_400_000;
  const targets = new Map(snapshot.targets.map((target) => [target.targetId, target]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.targetId, workspace]));
  const items = snapshot.sessions.flatMap((session): MobileHomeSessionItem[] => {
    if (session.hidden || session.derivationOrigin?.sideChat) return [];
    if (options.statusFilter === "active" && session.archived) return [];
    if (options.statusFilter === "archived" && !session.archived) return [];
    const projectId = session.projectId;
    const target = projectId === undefined ? undefined : targets.get(projectId);
    const workspace = projectId === undefined ? undefined : workspaces.get(projectId);
    const project = workspace?.kind === WorkspaceKind.USER_PROJECT;
    const groupKey = project ? `project:${projectId}` : "dialogue";
    if (options.projectId !== undefined && (!project || projectId !== options.projectId)) return [];
    if (!normalizedQuery && !session.pinned) {
      if (display.projectFilter !== "all" && !display.projectFilter.includes(groupKey)) return [];
      if (display.backendId !== null && display.backendId !== session.backendId) return [];
      if (cutoff !== undefined && sessionActivityMillis(session) < cutoff) return [];
    }
    const navigationName = target?.displayName || workspace?.displayName || (project ? options.labels.project : options.labels.dialogue);
    if (normalizedQuery && !session.displayName.toLocaleLowerCase().includes(normalizedQuery)
      && !navigationName.toLocaleLowerCase().includes(normalizedQuery)
      && options.messageSessionIds?.has(session.sessionId) !== true) return [];
    return [{
      session,
      navigationName,
      groupKind: project ? "project" : "dialogue",
      groupKey,
      groupTitle: project ? navigationName : options.labels.dialogue
    }];
  });
  if (normalizedQuery) {
    if (items.length === 0) return [];
    const ranks = new Map([...(options.messageSessionIds ?? [])].map((sessionId, index) => [sessionId, index] as const));
    const titleMatches = new Set(items.filter(({ session }) => session.displayName.toLocaleLowerCase().includes(normalizedQuery))
      .map(({ session }) => session.sessionId));
    const sorted = items.sort((left, right) => {
      const recent = compareHomeItems(right, left);
      if (recent !== 0 && options.searchSort === "activityAsc") return -recent;
      if (recent !== 0 && options.searchSort === "activityDesc") return recent;
      const leftId = left.session.sessionId;
      const rightId = right.session.sessionId;
      return Number(titleMatches.has(rightId)) - Number(titleMatches.has(leftId))
        || (ranks.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(rightId) ?? Number.MAX_SAFE_INTEGER)
        || Number(right.session.pinned) - Number(left.session.pinned)
        || recent || leftId.localeCompare(rightId);
    });
    return [{ key: "search", kind: "search", title: "", items: sorted }];
  }
  const sections: MobileHomeSection[] = [];
  const pinned = sortHomeItems(items.filter((item) => item.session.pinned));
  if (pinned.length > 0) sections.push({ key: "pinned", kind: "pinned", title: options.labels.pinned, items: pinned });

  const groups = new Map<string, { kind: "dialogue" | "project"; title: string; items: MobileHomeSessionItem[]; recent: MobileHomeSessionItem }>();
  for (const item of items) {
    if (item.session.pinned) continue;
    const current = groups.get(item.groupKey);
    if (current) {
      current.items.push(item);
      if (compareHomeItems(item, current.recent) > 0) current.recent = item;
    } else groups.set(item.groupKey, { kind: item.groupKind, title: item.groupTitle, items: [item], recent: item });
  }
  const grouped = [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) => compareHomeItems(right.recent, left.recent) || leftKey.localeCompare(rightKey))
    .map(([key, group]): MobileHomeSection => ({
      key,
      kind: group.kind,
      title: group.title,
      items: sortHomeItems(group.items, display.sortBy)
    }));
  if (display.projectOrder === "manual" && options.projectId === undefined) {
    const rank = new Map(display.manualProjectOrder.map((key, index) => [key, index] as const));
    const projects = grouped.filter(section => section.kind === "project").sort((left, right) =>
      (rank.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.key) ?? Number.MAX_SAFE_INTEGER));
    return [...sections, ...projects, ...grouped.filter(section => section.kind !== "project")];
  }
  return [...sections, ...grouped];
}

/** Reorders the visible projects in their existing slots, retaining the position of hidden projects. */
export function mergeMobileHomeProjectOrder(previous: readonly string[], allProjects: readonly string[], visible: readonly string[]): readonly string[] {
  const known = new Set(allProjects);
  const ordered = [...new Set([...previous, ...allProjects])].filter(key => known.has(key));
  const moved = [...new Set(visible)].filter(key => known.has(key));
  const visibleKeys = new Set(moved);
  let next = 0;
  return ordered.map(key => visibleKeys.has(key) ? moved[next++]! : key);
}

export function previewMobileHomeProject(
  items: readonly MobileHomeSessionItem[], pendingInteractions: ReadonlySet<string>, now: number
): readonly MobileHomeSessionItem[] {
  if (items.length <= MOBILE_HOME_PROJECT_PREVIEW_LIMIT) return items;
  return items.filter(({ session }, index) => index < MOBILE_HOME_PROJECT_PREVIEW_LIMIT
    || sessionActivityMillis(session) >= now - 86_400_000 || homeTaskPriority(session) < 3
    || pendingInteractions.has(session.sessionId));
}

function sessionActivityMillis(session: Session): number {
  const time = session.lastActivityAt;
  return time === undefined ? Number.NEGATIVE_INFINITY : Number(time.seconds) * 1_000 + time.nanos / 1_000_000;
}

function sortHomeItems(items: readonly MobileHomeSessionItem[], sortBy: MobileHomeTaskSort = "activity"): MobileHomeSessionItem[] {
  return [...items].sort((left, right) => {
    const byRecency = compareHomeItems(right, left);
    const comparison = sortBy === "created" ? compareTimestamps(right.session.createdAt, left.session.createdAt)
      : sortBy === "priority" ? homeTaskPriority(left.session) - homeTaskPriority(right.session) || byRecency : byRecency;
    return comparison || left.session.sessionId.localeCompare(right.session.sessionId);
  });
}

function homeTaskPriority(session: Session): number {
  if (session.state === SessionState.WAITING || session.attention?.unread
    && (session.attention.kind === SessionAttentionKind.AWAITING || session.attention.kind === SessionAttentionKind.ERROR)) return 0;
  if (session.state === SessionState.RUNNING || session.state === SessionState.RECOVERING) return 2;
  if (session.attention?.unread) return 1;
  return 3;
}

function compareHomeItems(left: MobileHomeSessionItem | undefined, right: MobileHomeSessionItem | undefined): number {
  return compareTimestamps(left?.session.lastActivityAt, right?.session.lastActivityAt);
}

function compareTimestamps(
  left: { readonly seconds: bigint; readonly nanos: number } | undefined,
  right: { readonly seconds: bigint; readonly nanos: number } | undefined
): number {
  const leftSeconds = left?.seconds ?? 0n;
  const rightSeconds = right?.seconds ?? 0n;
  if (leftSeconds !== rightSeconds) return leftSeconds > rightSeconds ? 1 : -1;
  const leftNanos = left?.nanos ?? 0;
  const rightNanos = right?.nanos ?? 0;
  return leftNanos === rightNanos ? 0 : leftNanos > rightNanos ? 1 : -1;
}

export const WIDE_SESSION_NAV_MIN_WIDTH = 600;

export interface WideSessionNavLayoutInput {
  readonly windowWidth?: number;
}

export interface WideSessionNavLayout {
  readonly enabled: boolean;
  readonly drawerWidth: number;
}

export function buildWideSessionNavLayout(input: WideSessionNavLayoutInput): WideSessionNavLayout {
  const width = positiveDimension(input.windowWidth);
  if (width < WIDE_SESSION_NAV_MIN_WIDTH) return { enabled: false, drawerWidth: 0 };
  return { enabled: true, drawerWidth: Math.min(width - 24, Math.min(360, Math.max(300, Math.round(width * 0.4)))) };
}

export interface MobileHomeNavigationLayoutInput {
  readonly windowWidth?: number;
  readonly windowHeight?: number;
  readonly safeInsets?: { readonly top?: number; readonly bottom?: number; readonly left?: number; readonly right?: number };
  readonly windowGeometry?: MobileWindowGeometry;
}

export interface MobileHomeNavigationLayout {
  readonly mode: "narrow" | "drawer" | "persistent";
  readonly drawerWidth: number;
  readonly sidebarWidth: number;
  readonly sidebarGap: number;
  readonly detailWidth: number;
}

export function buildMobileHomeNavigationLayout(input: MobileHomeNavigationLayoutInput): MobileHomeNavigationLayout {
  const width = positiveDimension(input.windowWidth);
  const height = positiveDimension(input.windowHeight);
  const geometry = input.windowGeometry;
  const safe = geometry ? safeWindowRect(geometry) : {
    x: positiveDimension(input.safeInsets?.left), y: positiveDimension(input.safeInsets?.top),
    width: Math.max(0, width - positiveDimension(input.safeInsets?.left) - positiveDimension(input.safeInsets?.right)),
    height: Math.max(0, height - positiveDimension(input.safeInsets?.top) - positiveDimension(input.safeInsets?.bottom))
  };
  const division = geometry ? windowDivision(geometry) : null;
  const splitAtDivision = division?.axis === "vertical" && division.first.width >= 240 && division.second.width >= 320;
  if (splitAtDivision || (!division && geometry?.regularWidth !== false && safe.width >= 760 && safe.height >= 480)) {
    const sidebarWidth = splitAtDivision ? division.first.width : Math.min(320, Math.round(safe.width * 0.34));
    const sidebarGap = splitAtDivision ? division.second.x - safe.x - sidebarWidth : 0;
    return { mode: "persistent", drawerWidth: 0, sidebarWidth, sidebarGap, detailWidth: safe.width - sidebarWidth - sidebarGap };
  }
  const quick = buildWideSessionNavLayout({ windowWidth: width });
  return { mode: quick.enabled ? "drawer" : "narrow", drawerWidth: quick.drawerWidth, sidebarWidth: 0, sidebarGap: 0, detailWidth: safe.width };
}

function positiveDimension(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface SwipeRowRegistry {
  onRowOpen(key: string, close: () => void): void;
  onRowClose(key: string): void;
  closeOpenRow(): boolean;
}

export function createSwipeRowRegistry(): SwipeRowRegistry {
  let current: { readonly key: string; readonly close: () => void } | undefined;
  return {
    onRowOpen(key, close) {
      if (current && current.key !== key) current.close();
      current = { key, close };
    },
    onRowClose(key) {
      if (current?.key === key) current = undefined;
    },
    closeOpenRow() {
      if (!current) return false;
      const closing = current;
      current = undefined;
      closing.close();
      return true;
    }
  };
}

export const FULL_SWIPE_RATIO = 0.55;

export type SwipeRelease = "pin" | "archive" | "reveal-pin" | "reveal-options" | "close";

export function resolveSwipeRelease(translationX: number, viewportWidth: number): SwipeRelease {
  if (!Number.isFinite(translationX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return "close";
  const ratio = translationX / viewportWidth;
  if (ratio >= FULL_SWIPE_RATIO) return "pin";
  if (ratio <= -FULL_SWIPE_RATIO) return "archive";
  if (translationX >= 44) return "reveal-pin";
  if (translationX <= -44) return "reveal-options";
  return "close";
}

export function shouldClaimHorizontalSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) >= 8 && Math.abs(dx) > Math.abs(dy) * 1.2;
}

export function shouldCloseDrawer(dx: number, velocityX: number, drawerWidth: number): boolean {
  if (!Number.isFinite(drawerWidth) || drawerWidth <= 0) return true;
  return dx <= -Math.max(64, drawerWidth * 0.2) || velocityX <= -0.65;
}
