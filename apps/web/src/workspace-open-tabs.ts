/**
 * Open-file tab state for the formal workspace files route.
 *
 * The selected file deliberately does not live here. The route query is the
 * single source of truth for the active file while this store only preserves
 * the ordered, per-workspace set of open tabs.
 */

export const WORKSPACE_OPEN_TABS_STORAGE_KEY = "joko.workspaceFiles.openTabs.v1";
export const MAX_WORKSPACE_TAB_BUCKETS = 100;
export const MAX_OPEN_TABS_PER_WORKSPACE = 200;

type OpenTabsBag = Record<string, string[]>;
export type WorkspaceOpenTabsListener = (workspaceId: string) => void;

export interface WorkspaceOpenTabsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class WorkspaceOpenTabsStore {
  readonly #storage: WorkspaceOpenTabsStorage | undefined;
  readonly #cache = new Map<string, string[]>();
  readonly #listeners = new Set<WorkspaceOpenTabsListener>();
  #bagLoaded = false;
  #bag: OpenTabsBag = {};

  constructor(storage: WorkspaceOpenTabsStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  getTabs(workspaceId: string): readonly string[] {
    if (workspaceId === "") return [];
    const cached = this.#cache.get(workspaceId);
    if (cached !== undefined) return cached;
    const tabs = this.#loadBag()[workspaceId] ?? [];
    this.#cache.set(workspaceId, tabs);
    return tabs;
  }

  addTab(workspaceId: string, path: string): boolean {
    if (workspaceId === "" || path === "") return false;
    const tabs = this.getTabs(workspaceId);
    if (tabs.includes(path)) return false;
    this.#commit(workspaceId, [...tabs, path]);
    return true;
  }

  removeTab(workspaceId: string, path: string): boolean {
    if (workspaceId === "" || path === "") return false;
    const tabs = this.getTabs(workspaceId);
    const index = tabs.indexOf(path);
    if (index < 0) return false;
    const next = [...tabs];
    next.splice(index, 1);
    this.#commit(workspaceId, next);
    return true;
  }

  /** Commits one atomic write and notification for a multi-tab close. */
  closeTabs(workspaceId: string, paths: readonly string[]): readonly string[] {
    if (workspaceId === "" || paths.length === 0) return [];
    const tabs = this.getTabs(workspaceId);
    if (tabs.length === 0) return [];
    const closing = new Set(paths);
    const next = tabs.filter((path) => !closing.has(path));
    if (next.length === tabs.length) return [];
    const closed = tabs.filter((path) => closing.has(path));
    this.#commit(workspaceId, next);
    return closed;
  }

  /** Moves a tab to a clamped index in the resulting array. */
  reorderTabs(workspaceId: string, fromIndex: number, toIndex: number): void {
    if (workspaceId === "") return;
    const tabs = this.getTabs(workspaceId);
    if (fromIndex < 0 || fromIndex >= tabs.length) return;
    const clamped = Math.max(0, Math.min(toIndex, tabs.length - 1));
    if (fromIndex === clamped) return;
    const next = [...tabs];
    const [moved] = next.splice(fromIndex, 1);
    if (moved === undefined) return;
    next.splice(clamped, 0, moved);
    this.#commit(workspaceId, next);
  }

  /** Rewrites file and descendant tab paths in place after a rename. */
  renameTabPrefix(workspaceId: string, fromPath: string, toPath: string): boolean {
    if (workspaceId === "" || fromPath === "" || toPath === "" || fromPath === toPath) return false;
    const prefix = `${fromPath}/`;
    let changed = false;
    const next = this.getTabs(workspaceId).map((path) => {
      if (path === fromPath) {
        changed = true;
        return toPath;
      }
      if (path.startsWith(prefix)) {
        changed = true;
        return `${toPath}/${path.slice(prefix.length)}`;
      }
      return path;
    });
    if (!changed) return false;
    this.#commit(workspaceId, next);
    return true;
  }

  subscribe(listener: WorkspaceOpenTabsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #loadBag(): OpenTabsBag {
    if (this.#bagLoaded) return this.#bag;
    this.#bagLoaded = true;
    try {
      const raw = this.#storage?.getItem(WORKSPACE_OPEN_TABS_STORAGE_KEY);
      if (raw === undefined || raw === null || raw === "") return this.#bag;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return this.#bag;
      const entries = Object.entries(parsed);
      if (entries.length > MAX_WORKSPACE_TAB_BUCKETS) return this.#bag;
      const bag: OpenTabsBag = {};
      for (const [workspaceId, candidate] of entries) {
        if (
          workspaceId === ""
          || !Array.isArray(candidate)
          || candidate.length > MAX_OPEN_TABS_PER_WORKSPACE
          || !candidate.every((path) => typeof path === "string" && path !== "")
          || new Set(candidate).size !== candidate.length
        ) return this.#bag;
        bag[workspaceId] = [...candidate];
      }
      this.#bag = bag;
    } catch {
      this.#bag = {};
    }
    return this.#bag;
  }

  #commit(workspaceId: string, tabs: readonly string[]): void {
    const capped = [...tabs].slice(0, MAX_OPEN_TABS_PER_WORKSPACE);
    this.#cache.set(workspaceId, capped);
    this.#loadBag();
    this.#bag[workspaceId] = capped;
    const workspaceIds = Object.keys(this.#bag);
    if (workspaceIds.length > MAX_WORKSPACE_TAB_BUCKETS) {
      const evicted = workspaceIds.sort().slice(0, workspaceIds.length - MAX_WORKSPACE_TAB_BUCKETS);
      for (const id of evicted) delete this.#bag[id];
    }
    try {
      this.#storage?.setItem(WORKSPACE_OPEN_TABS_STORAGE_KEY, JSON.stringify(this.#bag));
    } catch {
      // Quota and privacy-mode failures degrade to the in-memory cache.
    }
    for (const listener of this.#listeners) listener(workspaceId);
  }
}

/** Shared browser instance; injected stores remain available for deterministic tests. */
export const workspaceOpenTabsStore = new WorkspaceOpenTabsStore();

/**
 * Chooses the close successor from a live tab snapshot: first a
 * surviving tab to the right, then one to the left, otherwise no active file.
 */
export function nextActiveWorkspaceTab(
  liveTabs: readonly string[],
  activePath: string,
  pathsToClose: readonly string[]
): string | undefined {
  const activeIndex = liveTabs.indexOf(activePath);
  if (activeIndex < 0) return undefined;
  const closing = new Set(pathsToClose);
  for (let index = activeIndex + 1; index < liveTabs.length; index += 1) {
    const path = liveTabs[index];
    if (path !== undefined && !closing.has(path)) return path;
  }
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const path = liveTabs[index];
    if (path !== undefined && !closing.has(path)) return path;
  }
  return undefined;
}

function browserStorage(): WorkspaceOpenTabsStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
