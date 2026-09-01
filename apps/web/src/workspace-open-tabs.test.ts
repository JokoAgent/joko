import { describe, expect, it, vi } from "vitest";
import {
  MAX_OPEN_TABS_PER_WORKSPACE,
  MAX_WORKSPACE_TAB_BUCKETS,
  WORKSPACE_OPEN_TABS_STORAGE_KEY,
  WorkspaceOpenTabsStore,
  nextActiveWorkspaceTab,
  type WorkspaceOpenTabsStorage
} from "./workspace-open-tabs.js";

class MemoryStorage implements WorkspaceOpenTabsStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("WorkspaceOpenTabsStore", () => {
  it("persists ordered tabs per workspace and suppresses duplicate opens", () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceOpenTabsStore(storage);
    expect(store.addTab("workspace-a", "src/a.ts")).toBe(true);
    expect(store.addTab("workspace-a", "src/a.ts")).toBe(false);
    expect(store.addTab("workspace-a", "src/b.ts")).toBe(true);
    expect(store.addTab("workspace-b", "README.md")).toBe(true);

    const restored = new WorkspaceOpenTabsStore(storage);
    expect(restored.getTabs("workspace-a")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(restored.getTabs("workspace-b")).toEqual(["README.md"]);
  });

  it("closes batches atomically and notifies only the affected workspace once", () => {
    const store = new WorkspaceOpenTabsStore(new MemoryStorage());
    for (const path of ["a", "b", "c", "d"]) store.addTab("workspace", path);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.closeTabs("workspace", ["b", "missing", "d"])).toEqual(["b", "d"]);
    expect(store.getTabs("workspace")).toEqual(["a", "c"]);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("workspace");
    expect(store.closeTabs("workspace", ["missing"])).toEqual([]);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("reorders with clamped result indices and rewrites renamed descendants", () => {
    const store = new WorkspaceOpenTabsStore(new MemoryStorage());
    for (const path of ["src/a.ts", "src/nested/b.ts", "README.md"]) store.addTab("workspace", path);
    store.reorderTabs("workspace", 0, 99);
    expect(store.getTabs("workspace")).toEqual(["src/nested/b.ts", "README.md", "src/a.ts"]);
    expect(store.renameTabPrefix("workspace", "src", "lib")).toBe(true);
    expect(store.getTabs("workspace")).toEqual(["lib/nested/b.ts", "README.md", "lib/a.ts"]);
    expect(store.renameTabPrefix("workspace", "missing", "elsewhere")).toBe(false);
  });

  it("rejects malformed stored data and evicts excess workspace buckets deterministically", () => {
    const storage = new MemoryStorage();
    storage.values.set(WORKSPACE_OPEN_TABS_STORAGE_KEY, JSON.stringify({
      valid: Array.from({ length: MAX_OPEN_TABS_PER_WORKSPACE + 5 }, (_, index) => `file-${index}`),
      invalid: ["ok", 3]
    }));
    const store = new WorkspaceOpenTabsStore(storage);
    expect(store.getTabs("valid")).toEqual([]);
    expect(store.getTabs("invalid")).toEqual([]);

    for (let index = 0; index <= MAX_WORKSPACE_TAB_BUCKETS; index += 1) {
      store.addTab(`z-${String(index).padStart(3, "0")}`, "file.txt");
    }
    const persisted = JSON.parse(storage.values.get(WORKSPACE_OPEN_TABS_STORAGE_KEY) ?? "{}") as Record<string, string[]>;
    expect(Object.keys(persisted)).toHaveLength(MAX_WORKSPACE_TAB_BUCKETS);
    expect(persisted.valid).toBeUndefined();
  });

  it("keeps in-memory behavior when persistence is unavailable", () => {
    const store = new WorkspaceOpenTabsStore({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); }
    });
    expect(store.addTab("workspace", "file.ts")).toBe(true);
    expect(store.getTabs("workspace")).toEqual(["file.ts"]);
  });
});

describe("nextActiveWorkspaceTab", () => {
  it("prefers a surviving right neighbor, then a left neighbor", () => {
    expect(nextActiveWorkspaceTab(["a", "b", "c", "d"], "b", ["b", "c"])).toBe("d");
    expect(nextActiveWorkspaceTab(["a", "b", "c"], "c", ["b", "c"])).toBe("a");
    expect(nextActiveWorkspaceTab(["a"], "a", ["a"])).toBeUndefined();
  });

  it("uses the caller's live snapshot rather than a pre-dialog closure", () => {
    expect(nextActiveWorkspaceTab(["a", "b", "new"], "b", ["a", "b"])).toBe("new");
  });
});
