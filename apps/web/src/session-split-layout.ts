export type SessionSplitAxis = "row" | "column";
export type SessionSplitSide = "left" | "right" | "top" | "bottom";

export interface SessionSplitPane {
  readonly kind: "pane";
  readonly key: string;
  readonly sessionId: string;
}

export interface SessionSplitBranch {
  readonly kind: "split";
  readonly key: string;
  readonly axis: SessionSplitAxis;
  readonly ratio: number;
  readonly first: SessionSplitNode;
  readonly second: SessionSplitNode;
}

export type SessionSplitNode = SessionSplitPane | SessionSplitBranch;

export interface SessionSplitLayout {
  readonly root?: SessionSplitNode;
}

export const MAXIMUM_SESSION_SPLIT_PANES = 8;
export const MINIMUM_SESSION_SPLIT_RATIO = 0.1;
const STORAGE_VERSION = 1;
const STORAGE_PREFIX = "joko.session-split-layout.v1";
const MAXIMUM_STORED_TREE_DEPTH = 64;

interface StoredSessionSplitLayout {
  readonly version: typeof STORAGE_VERSION;
  readonly root: SessionSplitNode;
}

let keySequence = 0;
const memoryLayouts = new Map<string, SessionSplitLayout>();

function nextKey(prefix: "pane" | "split"): string {
  keySequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${keySequence.toString(36)}`;
}

function normalizeIdentity(value: string): string {
  return value.trim().slice(0, 512);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(MINIMUM_SESSION_SPLIT_RATIO, Math.min(1 - MINIMUM_SESSION_SPLIT_RATIO, value));
}

function axisForSide(side: SessionSplitSide): SessionSplitAxis {
  return side === "top" || side === "bottom" ? "column" : "row";
}

function insertedFirst(side: SessionSplitSide): boolean {
  return side === "left" || side === "top";
}

function storageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(normalizeIdentity(ownerId) || "anonymous")}`;
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function allKeys(node: SessionSplitNode | undefined, into = new Set<string>()): Set<string> {
  if (node === undefined) return into;
  into.add(node.key);
  if (node.kind === "split") {
    allKeys(node.first, into);
    allKeys(node.second, into);
  }
  return into;
}

export function sessionSplitPanes(node: SessionSplitNode | undefined): readonly SessionSplitPane[] {
  if (node === undefined) return [];
  if (node.kind === "pane") return [node];
  return [...sessionSplitPanes(node.first), ...sessionSplitPanes(node.second)];
}

export function sessionSplitSessionIds(layout: SessionSplitLayout): readonly string[] {
  return sessionSplitPanes(layout.root).map((pane) => pane.sessionId);
}

function replaceNode(
  node: SessionSplitNode,
  predicate: (candidate: SessionSplitNode) => boolean,
  replacement: (candidate: SessionSplitNode) => SessionSplitNode
): SessionSplitNode {
  if (predicate(node)) return replacement(node);
  if (node.kind === "pane") return node;
  const first = replaceNode(node.first, predicate, replacement);
  const second = replaceNode(node.second, predicate, replacement);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function removeSession(node: SessionSplitNode, sessionId: string): SessionSplitNode | undefined {
  if (node.kind === "pane") return node.sessionId === sessionId ? undefined : node;
  const first = removeSession(node.first, sessionId);
  const second = removeSession(node.second, sessionId);
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function readStoredNode(
  value: unknown,
  seenKeys: Set<string>,
  seenSessions: Set<string>,
  paneBudget: { value: number },
  depth = 0
): SessionSplitNode | undefined {
  if (depth > MAXIMUM_STORED_TREE_DEPTH) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const key = record["key"];
  if (!storedIdentity(key) || seenKeys.has(key)) return undefined;
  seenKeys.add(key);
  if (record["kind"] === "pane") {
    if (Object.keys(record).sort().join(",") !== "key,kind,sessionId") return undefined;
    if (paneBudget.value >= MAXIMUM_SESSION_SPLIT_PANES) return undefined;
    const sessionId = record["sessionId"];
    if (!storedIdentity(sessionId) || seenSessions.has(sessionId)) return undefined;
    paneBudget.value += 1;
    seenSessions.add(sessionId);
    return { kind: "pane", key, sessionId };
  }
  if (record["kind"] !== "split") return undefined;
  if (Object.keys(record).sort().join(",") !== "axis,first,key,kind,ratio,second") return undefined;
  if (record["axis"] !== "row" && record["axis"] !== "column") return undefined;
  if (typeof record["ratio"] !== "number" || !Number.isFinite(record["ratio"]) || clampRatio(record["ratio"]) !== record["ratio"]) return undefined;
  const first = readStoredNode(record["first"], seenKeys, seenSessions, paneBudget, depth + 1);
  const second = readStoredNode(record["second"], seenKeys, seenSessions, paneBudget, depth + 1);
  if (first === undefined || second === undefined) return undefined;
  return {
    kind: "split",
    key,
    axis: record["axis"],
    ratio: record["ratio"],
    first,
    second
  };
}

function storedIdentity(value: unknown): value is string {
  return typeof value === "string" && value !== "" && normalizeIdentity(value) === value;
}

export function normalizeSessionSplitLayout(value: unknown): SessionSplitLayout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "root,version" || record["version"] !== STORAGE_VERSION) return {};
  const root = readStoredNode(record["root"], new Set(), new Set(), { value: 0 });
  return sessionSplitPanes(root).length >= 2 ? { root } : {};
}

export function addSessionSplit(
  layout: SessionSplitLayout,
  sessionIdValue: string,
  anchorSessionIdValue: string,
  side: SessionSplitSide
): SessionSplitLayout {
  const sessionId = normalizeIdentity(sessionIdValue);
  const anchorSessionId = normalizeIdentity(anchorSessionIdValue);
  if (sessionId === "" || anchorSessionId === "" || sessionId === anchorSessionId) return layout;
  const panes = sessionSplitPanes(layout.root);
  if (panes.some((pane) => pane.sessionId === sessionId) || panes.length >= MAXIMUM_SESSION_SPLIT_PANES) return layout;
  if (layout.root !== undefined && !panes.some((pane) => pane.sessionId === anchorSessionId)) return layout;
  const keys = allKeys(layout.root);
  let paneKey = nextKey("pane");
  while (keys.has(paneKey)) paneKey = nextKey("pane");
  keys.add(paneKey);
  const inserted: SessionSplitPane = { kind: "pane", key: paneKey, sessionId };
  const branchFor = (anchor: SessionSplitPane): SessionSplitBranch => {
    let branchKey = nextKey("split");
    while (keys.has(branchKey)) branchKey = nextKey("split");
    keys.add(branchKey);
    return {
      kind: "split",
      key: branchKey,
      axis: axisForSide(side),
      ratio: 0.5,
      first: insertedFirst(side) ? inserted : anchor,
      second: insertedFirst(side) ? anchor : inserted
    };
  };
  if (layout.root === undefined) {
    let anchorKey = nextKey("pane");
    while (keys.has(anchorKey)) anchorKey = nextKey("pane");
    return { root: branchFor({ kind: "pane", key: anchorKey, sessionId: anchorSessionId }) };
  }
  return {
    root: replaceNode(
      layout.root,
      (node) => node.kind === "pane" && node.sessionId === anchorSessionId,
      (node) => branchFor(node as SessionSplitPane)
    )
  };
}

export function removeSessionSplit(layout: SessionSplitLayout, sessionIdValue: string): SessionSplitLayout {
  const sessionId = normalizeIdentity(sessionIdValue);
  if (sessionId === "" || layout.root === undefined) return layout;
  const root = removeSession(layout.root, sessionId);
  return sessionSplitPanes(root).length >= 2 ? { root } : {};
}

export function replaceSessionSplit(
  layout: SessionSplitLayout,
  currentSessionIdValue: string,
  nextSessionIdValue: string
): SessionSplitLayout {
  const currentSessionId = normalizeIdentity(currentSessionIdValue);
  const nextSessionId = normalizeIdentity(nextSessionIdValue);
  if (layout.root === undefined || currentSessionId === "" || nextSessionId === "" || currentSessionId === nextSessionId) return layout;
  const panes = sessionSplitPanes(layout.root);
  if (!panes.some((pane) => pane.sessionId === currentSessionId) || panes.some((pane) => pane.sessionId === nextSessionId)) return layout;
  return {
    root: replaceNode(
      layout.root,
      (node) => node.kind === "pane" && node.sessionId === currentSessionId,
      (node) => ({ ...node as SessionSplitPane, sessionId: nextSessionId })
    )
  };
}

export function resizeSessionSplit(layout: SessionSplitLayout, splitKeyValue: string, ratio: number): SessionSplitLayout {
  const splitKey = normalizeIdentity(splitKeyValue);
  if (layout.root === undefined || splitKey === "") return layout;
  const root = replaceNode(
    layout.root,
    (node) => node.kind === "split" && node.key === splitKey,
    (node) => ({ ...node as SessionSplitBranch, ratio: clampRatio(ratio) })
  );
  return root === layout.root ? layout : { root };
}

export function setRootSessionSplitAxis(layout: SessionSplitLayout, axis: SessionSplitAxis): SessionSplitLayout {
  if (layout.root?.kind !== "split" || layout.root.axis === axis) return layout;
  return { root: { ...layout.root, axis } };
}

export function reconcileSessionSplit(layout: SessionSplitLayout, existingSessionIds: ReadonlySet<string>): SessionSplitLayout {
  let next = layout;
  for (const sessionId of sessionSplitSessionIds(layout)) {
    if (!existingSessionIds.has(sessionId)) next = removeSessionSplit(next, sessionId);
  }
  return next;
}

export function readSessionSplitLayout(ownerId: string, persist = true): SessionSplitLayout {
  const key = storageKey(ownerId);
  if (!persist) return memoryLayouts.get(key) ?? {};
  const storage = localStorageOrUndefined();
  if (storage !== undefined) {
    try {
      const raw = storage.getItem(key);
      if (raw !== null) {
        const layout = normalizeSessionSplitLayout(JSON.parse(raw) as unknown);
        memoryLayouts.set(key, layout);
        return layout;
      }
    } catch {
      // Corrupt or blocked storage falls through to the in-process copy.
    }
  }
  return memoryLayouts.get(key) ?? {};
}

export function writeSessionSplitLayout(ownerId: string, layout: SessionSplitLayout, persist = true): void {
  const key = storageKey(ownerId);
  const normalized = normalizeSessionSplitLayout({ version: STORAGE_VERSION, root: layout.root });
  memoryLayouts.set(key, normalized);
  if (!persist) return;
  const storage = localStorageOrUndefined();
  if (storage === undefined) return;
  try {
    if (normalized.root === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: STORAGE_VERSION, root: normalized.root } satisfies StoredSessionSplitLayout));
  } catch {
    // Layout persistence is optional; the in-process copy remains usable.
  }
}

export function clearSessionSplitLayoutForTests(): void {
  memoryLayouts.clear();
  keySequence = 0;
}
