import { canonicalWorkspaceRelativePath } from "./components/workspace-tree-state.js";

/** Per-workspace continuity for the formal Files route; the URL remains active truth. */
export const WORKSPACE_SELECTED_FILE_STORAGE_KEY = "joko.workspaceFiles.selectedFile.v1";
export const MAX_SELECTED_FILE_WORKSPACES = 100;

type SelectedFileBag = Record<string, string>;

export interface WorkspaceSelectedFileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class WorkspaceSelectedFileStore {
  readonly #storage: WorkspaceSelectedFileStorage | undefined;
  #loaded = false;
  #bag: SelectedFileBag = {};

  constructor(storage: WorkspaceSelectedFileStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  get(workspaceId: string): string | undefined {
    if (workspaceId === "") return undefined;
    const value = this.#load()[workspaceId];
    if (value === undefined) return undefined;
    try {
      return canonicalWorkspaceRelativePath(value);
    } catch {
      return undefined;
    }
  }

  set(workspaceId: string, path: string): boolean {
    if (workspaceId === "") return false;
    let canonical: string;
    try {
      canonical = canonicalWorkspaceRelativePath(path);
    } catch {
      return false;
    }
    const bag = this.#load();
    if (bag[workspaceId] === canonical) return false;
    bag[workspaceId] = canonical;
    this.#persist();
    return true;
  }

  clear(workspaceId: string): boolean {
    if (workspaceId === "") return false;
    const bag = this.#load();
    if (!(workspaceId in bag)) return false;
    delete bag[workspaceId];
    this.#persist();
    return true;
  }

  /** Rewrites the remembered file when a selected file or one of its parents moves. */
  renamePrefix(workspaceId: string, fromPath: string, toPath: string): string | undefined {
    const selected = this.get(workspaceId);
    if (selected === undefined) return undefined;
    let from: string;
    let to: string;
    try {
      from = canonicalWorkspaceRelativePath(fromPath);
      to = canonicalWorkspaceRelativePath(toPath);
    } catch {
      return undefined;
    }
    const next = selected === from
      ? to
      : selected.startsWith(`${from}/`)
        ? `${to}/${selected.slice(from.length + 1)}`
        : undefined;
    if (next === undefined) return undefined;
    this.set(workspaceId, next);
    return next;
  }

  /** Clears a remembered file deleted directly or through a parent-directory delete. */
  clearPrefix(workspaceId: string, path: string): boolean {
    const selected = this.get(workspaceId);
    if (selected === undefined) return false;
    let canonical: string;
    try {
      canonical = canonicalWorkspaceRelativePath(path);
    } catch {
      return false;
    }
    return selected === canonical || selected.startsWith(`${canonical}/`)
      ? this.clear(workspaceId)
      : false;
  }

  #load(): SelectedFileBag {
    if (this.#loaded) return this.#bag;
    this.#loaded = true;
    try {
      const raw = this.#storage?.getItem(WORKSPACE_SELECTED_FILE_STORAGE_KEY);
      if (raw === undefined || raw === null || raw === "") return this.#bag;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return this.#bag;
      const entries = Object.entries(parsed);
      if (entries.length > MAX_SELECTED_FILE_WORKSPACES) return this.#bag;
      const bag: SelectedFileBag = {};
      for (const [workspaceId, path] of entries) {
        if (workspaceId === "" || typeof path !== "string") return this.#bag;
        try {
          const canonical = canonicalWorkspaceRelativePath(path);
          if (canonical !== path) return this.#bag;
          bag[workspaceId] = canonical;
        } catch {
          return this.#bag;
        }
      }
      this.#bag = bag;
    } catch {
      this.#bag = {};
    }
    return this.#bag;
  }

  #persist(): void {
    const workspaceIds = Object.keys(this.#bag);
    if (workspaceIds.length > MAX_SELECTED_FILE_WORKSPACES) {
      const evicted = workspaceIds.sort().slice(0, workspaceIds.length - MAX_SELECTED_FILE_WORKSPACES);
      for (const workspaceId of evicted) delete this.#bag[workspaceId];
    }
    try {
      this.#storage?.setItem(WORKSPACE_SELECTED_FILE_STORAGE_KEY, JSON.stringify(this.#bag));
    } catch {
      // Privacy modes and quota failures retain the bounded in-memory bag.
    }
  }
}

export const workspaceSelectedFileStore = new WorkspaceSelectedFileStore();

function browserStorage(): WorkspaceSelectedFileStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
