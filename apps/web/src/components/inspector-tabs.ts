export const INSPECTOR_TAB_KINDS = ["context", "branches", "files", "changes", "background", "subagents", "terminal", "tools", "browser"] as const;

export type InspectorTabKind = (typeof INSPECTOR_TAB_KINDS)[number];

export interface InspectorTabState {
  readonly id: string;
  readonly kind: InspectorTabKind;
}

export interface InspectorTabBucket {
  readonly tabs: readonly InspectorTabState[];
  readonly activeTabId?: string;
}

export type InspectorTabBuckets = Readonly<Record<string, InspectorTabBucket>>;

const MAX_PERSISTED_SESSIONS = 200;

export function createInitialInspectorTabBucket(): InspectorTabBucket {
  return { tabs: [{ id: "context", kind: "context" }], activeTabId: "context" };
}

export function projectInspectorTabBucket(
  bucket: InspectorTabBucket,
  availableKinds: ReadonlySet<InspectorTabKind>
): InspectorTabBucket {
  const tabs = bucket.tabs.filter((tab) => availableKinds.has(tab.kind));
  const activeTabId = tabs.some((tab) => tab.id === bucket.activeTabId)
    ? bucket.activeTabId
    : tabs[0]?.id;
  return { tabs, activeTabId };
}

export function addInspectorTab(bucket: InspectorTabBucket, kind: InspectorTabKind): InspectorTabBucket {
  const existing = bucket.tabs.find((tab) => tab.kind === kind);
  if (existing !== undefined) return { ...bucket, activeTabId: existing.id };
  const tab = { id: kind, kind } as const;
  return { tabs: [...bucket.tabs, tab], activeTabId: tab.id };
}

export function activateInspectorTab(bucket: InspectorTabBucket, tabId: string): InspectorTabBucket {
  return bucket.tabs.some((tab) => tab.id === tabId) ? { ...bucket, activeTabId: tabId } : bucket;
}

export function closeInspectorTab(bucket: InspectorTabBucket, tabId: string): InspectorTabBucket {
  const index = bucket.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return bucket;
  const tabs = bucket.tabs.filter((tab) => tab.id !== tabId);
  if (bucket.activeTabId !== tabId) return { ...bucket, tabs };
  return { tabs, activeTabId: tabs[Math.min(index, tabs.length - 1)]?.id };
}

export function closeOtherInspectorTabs(
  bucket: InspectorTabBucket,
  keepTabId: string,
  visibleTabIds: ReadonlySet<string>
): InspectorTabBucket {
  const tabs = bucket.tabs.filter((tab) => tab.id === keepTabId || !visibleTabIds.has(tab.id));
  return tabs.some((tab) => tab.id === keepTabId)
    ? { tabs, activeTabId: keepTabId }
    : bucket;
}

export function closeVisibleInspectorTabs(
  bucket: InspectorTabBucket,
  visibleTabIds: ReadonlySet<string>
): InspectorTabBucket {
  const tabs = bucket.tabs.filter((tab) => !visibleTabIds.has(tab.id));
  const activeTabId = tabs.some((tab) => tab.id === bucket.activeTabId) ? bucket.activeTabId : tabs[0]?.id;
  return { tabs, activeTabId };
}

export function reorderVisibleInspectorTabs(
  bucket: InspectorTabBucket,
  orderedVisibleIds: readonly string[]
): InspectorTabBucket {
  const byId = new Map(bucket.tabs.map((tab) => [tab.id, tab]));
  const visibleIds = new Set(orderedVisibleIds);
  if (visibleIds.size !== orderedVisibleIds.length || orderedVisibleIds.some((id) => !byId.has(id))) return bucket;
  const ordered = orderedVisibleIds.map((id) => byId.get(id) as InspectorTabState);
  let cursor = 0;
  const tabs = bucket.tabs.map((tab) => visibleIds.has(tab.id) ? ordered[cursor++] as InspectorTabState : tab);
  return { ...bucket, tabs };
}

export function moveVisibleInspectorTab(
  bucket: InspectorTabBucket,
  visibleTabs: readonly InspectorTabState[],
  tabId: string,
  direction: -1 | 1
): InspectorTabBucket {
  const index = visibleTabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return bucket;
  const target = index + direction;
  if (target < 0 || target >= visibleTabs.length) return bucket;
  const orderedIds = visibleTabs.map((tab) => tab.id);
  [orderedIds[index], orderedIds[target]] = [orderedIds[target] as string, orderedIds[index] as string];
  return reorderVisibleInspectorTabs(bucket, orderedIds);
}

export function cycleInspectorTabId(
  tabs: readonly InspectorTabState[],
  activeTabId: string | undefined,
  direction: -1 | 1
): string | undefined {
  if (tabs.length === 0) return undefined;
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  const baseIndex = activeIndex < 0 ? (direction === 1 ? -1 : 0) : activeIndex;
  return tabs[(baseIndex + direction + tabs.length) % tabs.length]?.id;
}

export function parseInspectorTabBuckets(raw: string | null): InspectorTabBuckets {
  if (raw === null || raw === "") return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {}; }
  if (!isRecord(value)) return {};
  if (Object.keys(value).length > MAX_PERSISTED_SESSIONS) return {};
  const buckets: Record<string, InspectorTabBucket> = {};
  for (const [sessionId, candidate] of Object.entries(value)) {
    if (!isSafeSessionKey(sessionId) || !isRecord(candidate) || !Array.isArray(candidate.tabs)) return {};
    const candidateKeys = Object.keys(candidate).sort().join(",");
    if (candidateKeys !== "activeTabId,tabs" && candidateKeys !== "tabs") return {};
    const tabs: InspectorTabState[] = [];
    const kinds = new Set<InspectorTabKind>();
    const ids = new Set<string>();
    for (const rawTab of candidate.tabs) {
      if (!isRecord(rawTab) || Object.keys(rawTab).sort().join(",") !== "id,kind" || !isInspectorTabKind(rawTab.kind) || kinds.has(rawTab.kind)) return {};
      if (typeof rawTab.id !== "string" || rawTab.id.length === 0 || rawTab.id.length > 128 || ids.has(rawTab.id)) return {};
      const id = rawTab.id;
      kinds.add(rawTab.kind);
      ids.add(id);
      tabs.push({ id, kind: rawTab.kind });
    }
    const activeTabId = candidate.activeTabId;
    if ((tabs.length === 0 && activeTabId !== undefined) || (tabs.length > 0 && (typeof activeTabId !== "string" || !tabs.some((tab) => tab.id === activeTabId)))) return {};
    buckets[sessionId] = activeTabId === undefined ? { tabs } : { tabs, activeTabId: activeTabId as string };
  }
  return buckets;
}

export function serializeInspectorTabBuckets(buckets: InspectorTabBuckets): string {
  return JSON.stringify(buckets);
}

function isInspectorTabKind(value: unknown): value is InspectorTabKind {
  return typeof value === "string" && (INSPECTOR_TAB_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeSessionKey(value: string): boolean {
  return value !== "" && value.length <= 512 && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}
