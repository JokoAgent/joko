import { WorkspaceKind, type Session, type Snapshot } from "@joko/contracts";

export type MobileHomeStatusFilter = "active" | "archived" | "all";

export interface MobileHomeSessionItem {
  readonly session: Session;
  readonly targetName: string;
  readonly groupKind: "dialogue" | "project";
  readonly groupKey: string;
  readonly groupTitle: string;
}

export interface MobileHomeSection {
  readonly key: string;
  readonly kind: "pinned" | "dialogue" | "project";
  readonly title: string;
  readonly items: readonly MobileHomeSessionItem[];
}

export interface BuildMobileHomeSectionsOptions {
  readonly snapshot: Snapshot | undefined;
  readonly statusFilter: MobileHomeStatusFilter;
  readonly query: string;
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
  const targets = new Map(snapshot.targets.map((target) => [target.targetId, target]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.targetId, workspace]));
  const visible = snapshot.sessions.filter((session) => {
    if (options.statusFilter === "active" && session.archived) return false;
    if (options.statusFilter === "archived" && !session.archived) return false;
    if (!normalizedQuery) return true;
    const target = targets.get(session.targetId);
    return session.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || target?.displayName.toLocaleLowerCase().includes(normalizedQuery) === true
      || options.messageSessionIds?.has(session.sessionId) === true;
  });
  const items = visible.map((session): MobileHomeSessionItem => {
    const target = targets.get(session.targetId);
    const workspace = workspaces.get(session.targetId);
    const project = workspace?.kind === WorkspaceKind.USER_PROJECT;
    return {
      session,
      targetName: target?.displayName || options.labels.dialogue,
      groupKind: project ? "project" : "dialogue",
      groupKey: project ? `project:${session.targetId}` : "dialogue",
      groupTitle: project ? target?.displayName || workspace.displayName || options.labels.project : options.labels.dialogue
    };
  });
  const sections: MobileHomeSection[] = [];
  const pinned = sortHomeItems(items.filter((item) => item.session.pinned));
  if (pinned.length > 0) sections.push({ key: "pinned", kind: "pinned", title: options.labels.pinned, items: pinned });

  const groups = new Map<string, { kind: "dialogue" | "project"; title: string; items: MobileHomeSessionItem[] }>();
  for (const item of items) {
    if (item.session.pinned) continue;
    const current = groups.get(item.groupKey);
    if (current) current.items.push(item);
    else groups.set(item.groupKey, { kind: item.groupKind, title: item.groupTitle, items: [item] });
  }
  const grouped = [...groups.entries()].map(([key, group]): MobileHomeSection => ({
    key,
    kind: group.kind,
    title: group.title,
    items: sortHomeItems(group.items)
  }));
  grouped.sort((left, right) => compareHomeItems(right.items[0], left.items[0]) || left.key.localeCompare(right.key));
  return [...sections, ...grouped];
}

function sortHomeItems(items: readonly MobileHomeSessionItem[]): MobileHomeSessionItem[] {
  return [...items].sort((left, right) => compareHomeItems(right, left) || left.session.sessionId.localeCompare(right.session.sessionId));
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
  readonly platform?: string;
  readonly iosPad?: boolean;
}

export interface WideSessionNavLayout {
  readonly enabled: boolean;
  readonly drawerWidth: number;
}

export function buildWideSessionNavLayout(input: WideSessionNavLayoutInput): WideSessionNavLayout {
  const width = Number.isFinite(input.windowWidth) && (input.windowWidth ?? 0) > 0 ? input.windowWidth! : 0;
  const platformAllowed = input.platform !== "ios" || input.iosPad === true;
  if (!platformAllowed || width < WIDE_SESSION_NAV_MIN_WIDTH) return { enabled: false, drawerWidth: 0 };
  return { enabled: true, drawerWidth: Math.min(360, Math.max(300, Math.round(width * 0.4))) };
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
