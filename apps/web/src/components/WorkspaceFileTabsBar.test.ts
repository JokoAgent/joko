import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceFileTabMenuKey,
  workspaceFileTabCloseSet
} from "./WorkspaceFileTabsBar.js";

describe("WorkspaceFileTabsBar close groups", () => {
  const tabs = ["a.ts", "src/b.ts", "c.ts", "d.ts"] as const;

  it("supports close, other, left, right, and all groups", () => {
    expect(workspaceFileTabCloseSet("tab", tabs, "src/b.ts")).toEqual(["src/b.ts"]);
    expect(workspaceFileTabCloseSet("others", tabs, "src/b.ts")).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(workspaceFileTabCloseSet("left", tabs, "src/b.ts")).toEqual(["a.ts"]);
    expect(workspaceFileTabCloseSet("right", tabs, "src/b.ts")).toEqual(["c.ts", "d.ts"]);
    expect(workspaceFileTabCloseSet("all", tabs, "src/b.ts")).toEqual(tabs);
  });

  it("fails closed when a stale menu anchor no longer exists", () => {
    expect(workspaceFileTabCloseSet("all", tabs, "missing.ts")).toEqual([]);
  });
});

describe("WorkspaceFileTabsBar context menu keyboard behavior", () => {
  const labels = ["Copy path", "Close", "Close others", "Close right", "Close left", "Close all"] as const;
  const key = (value: string, overrides: Partial<Parameters<typeof resolveWorkspaceFileTabMenuKey>[0]> = {}) => resolveWorkspaceFileTabMenuKey({
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    currentIndex: 0,
    itemLabels: labels,
    typeahead: "",
    ...overrides
  });

  it("wraps enabled menu items and honors Home and End", () => {
    expect(key("ArrowDown", { currentIndex: labels.length - 1 })).toEqual({ kind: "focus", index: 0 });
    expect(key("ArrowUp", { currentIndex: 0 })).toEqual({ kind: "focus", index: labels.length - 1 });
    expect(key("ArrowDown", { currentIndex: -1 })).toEqual({ kind: "focus", index: 0 });
    expect(key("ArrowUp", { currentIndex: -1 })).toEqual({ kind: "focus", index: labels.length - 1 });
    expect(key("Home", { currentIndex: 4 })).toEqual({ kind: "focus", index: 0 });
    expect(key("End", { currentIndex: 1 })).toEqual({ kind: "focus", index: labels.length - 1 });
  });

  it("supports progressive typeahead, wraparound, and repeated-key cycling", () => {
    expect(key("c", { currentIndex: 0 })).toEqual({ kind: "typeahead", value: "c", index: 1 });
    expect(key("l", { currentIndex: 1, typeahead: "c" })).toEqual({ kind: "typeahead", value: "cl", index: 2 });
    expect(key("c", { currentIndex: 5, typeahead: "c" })).toEqual({ kind: "typeahead", value: "c", index: 0 });
    expect(key("z", { currentIndex: 2 })).toEqual({ kind: "typeahead", value: "z" });
    expect(key("c", { ctrlKey: true })).toBeNull();
    expect(key(" ")).toBeNull();
  });

  it("owns Escape", () => {
    expect(key("Escape")).toEqual({ kind: "close" });
  });
});
