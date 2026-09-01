import { describe, expect, it } from "vitest";

import {
  MAX_SELECTED_FILE_WORKSPACES,
  WORKSPACE_SELECTED_FILE_STORAGE_KEY,
  WorkspaceSelectedFileStore,
  type WorkspaceSelectedFileStorage
} from "./workspace-selected-file.js";

class MemoryStorage implements WorkspaceSelectedFileStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("WorkspaceSelectedFileStore", () => {
  it("persists one selected file per workspace and synchronizes clear/rename/delete", () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceSelectedFileStore(storage);
    expect(store.set("workspace-a", "src/a.ts")).toBe(true);
    expect(store.set("workspace-b", "README.md")).toBe(true);
    expect(new WorkspaceSelectedFileStore(storage).get("workspace-a")).toBe("src/a.ts");

    expect(store.renamePrefix("workspace-a", "src", "lib")).toBe("lib/a.ts");
    expect(store.get("workspace-a")).toBe("lib/a.ts");
    expect(store.clearPrefix("workspace-a", "lib")).toBe(true);
    expect(store.get("workspace-a")).toBeUndefined();
    expect(store.clear("workspace-b")).toBe(true);
  });

  it("rejects malformed stored bags and bounds persisted workspace buckets", () => {
    const storage = new MemoryStorage();
    storage.values.set(WORKSPACE_SELECTED_FILE_STORAGE_KEY, JSON.stringify({
      unsafe: "../secret.txt",
      safe: "guides/PROJECT_OVERVIEW.md"
    }));
    const store = new WorkspaceSelectedFileStore(storage);
    expect(store.get("unsafe")).toBeUndefined();
    expect(store.get("safe")).toBeUndefined();
    expect(store.set("safe", "guides/PROJECT_OVERVIEW.md")).toBe(true);

    for (let index = 0; index <= MAX_SELECTED_FILE_WORKSPACES; index += 1) {
      store.set(`z-${String(index).padStart(3, "0")}`, "file.txt");
    }
    const persisted = JSON.parse(storage.values.get(WORKSPACE_SELECTED_FILE_STORAGE_KEY) ?? "{}") as Record<string, string>;
    expect(Object.keys(persisted)).toHaveLength(MAX_SELECTED_FILE_WORKSPACES);
    expect(persisted.safe).toBeUndefined();
  });

  it("keeps bounded in-memory behavior when browser persistence fails", () => {
    const store = new WorkspaceSelectedFileStore({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); }
    });
    expect(store.set("workspace", "file.ts")).toBe(true);
    expect(store.get("workspace")).toBe("file.ts");
  });
});
