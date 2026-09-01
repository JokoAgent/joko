import { describe, expect, it } from "vitest";

import {
  WORKSPACE_ENTRY_DRAG_MIME,
  WORKSPACE_EXPANDED_STORAGE_KEY,
  canonicalWorkspaceRelativePath,
  createWorkspaceEntryDragPayload,
  decodeWorkspaceEntryDragPayload,
  encodeWorkspaceEntryDragPayload,
  filterWorkspaceFiles,
  flattenWorkspaceTree,
  loadWorkspaceExpandedPaths,
  normalizeWorkspaceDirectoryEntries,
  normalizeWorkspaceFileIndex,
  removeWorkspacePathPrefix,
  resolveWorkspaceTreeKeyboardAction,
  rewriteWorkspacePathPrefix,
  saveWorkspaceExpandedPaths,
  workspacePathAncestors,
  type WorkspaceDirectoryView,
  type WorkspaceFilesStorage
} from "./workspace-tree-state.js";

class MemoryStorage implements WorkspaceFilesStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("workspace path boundary", () => {
  it("accepts canonical relative paths and computes their ancestor chain", () => {
    expect(canonicalWorkspaceRelativePath("src/components/App.tsx")).toBe("src/components/App.tsx");
    expect(canonicalWorkspaceRelativePath("", true)).toBe("");
    expect(workspacePathAncestors("src/components/App.tsx")).toEqual(["src", "src/components"]);
  });

  it.each([
    "",
    "/etc/passwd",
    "C:/secret.txt",
    "../secret.txt",
    "src/../secret.txt",
    "src\\secret.txt",
    "src//secret.txt",
    "src/secret. ",
    "src/evil\u0000.txt",
    "src/evil\u0085.txt",
    "src/evil\u061c.txt",
    "src/evil\u200e.txt",
    "src/evil\u2028.txt",
    "src/evil\u202e.txt"
  ])("fails closed for %j", (path) => {
    expect(() => canonicalWorkspaceRelativePath(path)).toThrow(/canonical relative path/u);
  });

  it("rejects unsafe values in file indexes instead of partially trusting them", () => {
    expect(() => normalizeWorkspaceFileIndex(["src/a.ts", "/tmp/server-only.txt"])).toThrow();
  });
});

describe("workspace tree state", () => {
  it("requires direct children, rejects duplicates, and sorts folders before files", () => {
    const entries = normalizeWorkspaceDirectoryEntries("src", [
      { path: "src/z.ts", name: "z.ts", kind: "file" },
      { path: "src/folder10", name: "folder10", kind: "directory" },
      { path: "src/folder2", name: "folder2", kind: "directory" },
      { path: "src/A.ts", name: "A.ts", kind: "file" }
    ]);
    expect(entries.map((entry) => entry.path)).toEqual([
      "src/folder10",
      "src/folder2",
      "src/A.ts",
      "src/z.ts"
    ]);
    expect(() => normalizeWorkspaceDirectoryEntries("src", [
      { path: "elsewhere/a.ts", name: "a.ts", kind: "file" }
    ])).toThrow(/outside its requested parent/u);
    expect(() => normalizeWorkspaceDirectoryEntries("src", [
      { path: "src/a.ts", name: "a.ts", kind: "file" },
      { path: "src/a.ts", name: "a.ts", kind: "file" }
    ])).toThrow(/duplicate/u);
  });

  it("flattens only expanded directory branches and exposes predictable keyboard actions", () => {
    const directories = new Map<string, WorkspaceDirectoryView>([
      ["", { status: "loaded", entries: [
        { path: "src", name: "src", kind: "directory" },
        { path: "README.md", name: "README.md", kind: "file" }
      ] }],
      ["src", { status: "loaded", entries: [
        { path: "src/App.tsx", name: "App.tsx", kind: "file" }
      ] }]
    ]);
    const collapsedRows = flattenWorkspaceTree(directories, new Set());
    expect(collapsedRows.map((row) => row.entry.path)).toEqual(["src", "README.md"]);
    expect(resolveWorkspaceTreeKeyboardAction(collapsedRows, "src", "ArrowRight", new Set())).toEqual({
      togglePath: "src",
      focusPath: "src"
    });

    const expanded = new Set(["src"]);
    const rows = flattenWorkspaceTree(directories, expanded);
    expect(rows.map((row) => [row.entry.path, row.depth])).toEqual([
      ["src", 0],
      ["src/App.tsx", 1],
      ["README.md", 0]
    ]);
    expect(resolveWorkspaceTreeKeyboardAction(rows, "src", "ArrowRight", expanded)).toEqual({ focusPath: "src/App.tsx" });
    expect(resolveWorkspaceTreeKeyboardAction(rows, "src/App.tsx", "ArrowLeft", expanded)).toEqual({ focusPath: "src" });
    expect(resolveWorkspaceTreeKeyboardAction(rows, "src/App.tsx", "Enter", expanded)).toEqual({
      selectPath: "src/App.tsx",
      focusPath: "src/App.tsx"
    });
    expect(resolveWorkspaceTreeKeyboardAction(rows, "README.md", "Home", expanded)).toEqual({ focusPath: "src" });
  });

  it("filters filenames with case-insensitive basename hits before path-only hits", () => {
    expect(filterWorkspaceFiles("foo", [
      "foo-parent/z.ts",
      "src/FooButton.tsx",
      "src/foo.ts",
      "src/no-match.ts"
    ])).toEqual([
      "src/FooButton.tsx",
      "src/foo.ts",
      "foo-parent/z.ts"
    ]);
    expect(filterWorkspaceFiles("foo", ["foo.ts", "foo2.ts", "foo3.ts"], 2)).toEqual(["foo.ts", "foo2.ts"]);
    expect(filterWorkspaceFiles("foo", ["foo-parent/a.ts", "foo-parent/b.ts", "src/foo.ts"], 2)).toEqual([
      "foo-parent/a.ts",
      "foo-parent/b.ts"
    ]);
  });

  it("persists expansion per workspace with a bounded path set and tolerates corrupt storage", () => {
    const storage = new MemoryStorage();
    const paths = new Set(Array.from({ length: 220 }, (_, index) => `folder-${index}`));
    saveWorkspaceExpandedPaths("workspace-a", paths, storage);
    expect([...loadWorkspaceExpandedPaths("workspace-a", storage)]).toHaveLength(200);
    expect([...loadWorkspaceExpandedPaths("workspace-b", storage)]).toEqual([]);

    storage.values.set(WORKSPACE_EXPANDED_STORAGE_KEY, "{not-json");
    expect([...loadWorkspaceExpandedPaths("workspace-a", storage)]).toEqual([]);
  });

  it("rewrites and removes expanded descendants after document-host mutations", () => {
    const expanded = new Set(["docs", "docs/api", "src"]);
    expect([...rewriteWorkspacePathPrefix(expanded, "docs", "guides")]).toEqual(["guides", "guides/api", "src"]);
    expect([...removeWorkspacePathPrefix(expanded, "docs")]).toEqual(["src"]);
  });
});

describe("workspace drag snapshots", () => {
  it("encodes only a canonical relative entry snapshot in the custom drag MIME", () => {
    expect(WORKSPACE_ENTRY_DRAG_MIME).toBe("application/x-joko-workspace-entry+json");
    const payload = createWorkspaceEntryDragPayload("workspace-a", {
      path: "src/App.tsx",
      name: "App.tsx",
      kind: "file",
      revision: "must-not-leak",
      status: "modified"
    });
    expect(JSON.parse(encodeWorkspaceEntryDragPayload(payload))).toEqual({
      version: 1,
      workspaceId: "workspace-a",
      kind: "file",
      path: "src/App.tsx",
      name: "App.tsx"
    });
    expect(decodeWorkspaceEntryDragPayload(encodeWorkspaceEntryDragPayload(payload))).toEqual(payload);
    expect(decodeWorkspaceEntryDragPayload(JSON.stringify({ ...payload, path: "../secret", name: "secret" }))).toBeUndefined();
    expect(decodeWorkspaceEntryDragPayload("not-json")).toBeUndefined();
    expect(() => createWorkspaceEntryDragPayload("workspace-a", {
      path: "/server/private.ts",
      name: "private.ts",
      kind: "file"
    })).toThrow();
  });
});
