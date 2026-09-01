import { describe, expect, it } from "vitest";
import {
  activateInspectorTab,
  addInspectorTab,
  closeInspectorTab,
  closeOtherInspectorTabs,
  closeVisibleInspectorTabs,
  createInitialInspectorTabBucket,
  cycleInspectorTabId,
  moveVisibleInspectorTab,
  parseInspectorTabBuckets,
  projectInspectorTabBucket,
  reorderVisibleInspectorTabs,
  serializeInspectorTabBuckets,
  type InspectorTabBucket,
  type InspectorTabKind
} from "./inspector-tabs.js";

const ALL = new Set<InspectorTabKind>(["context", "branches", "files", "changes", "background", "subagents", "terminal", "tools", "browser"]);
const BUCKET: InspectorTabBucket = {
  tabs: [
    { id: "context", kind: "context" },
    { id: "files", kind: "files" },
    { id: "tools", kind: "tools" }
  ],
  activeTabId: "files"
};

describe("inspector tab buckets", () => {
  it("creates and activates singleton tabs without duplicating a kind", () => {
    expect(createInitialInspectorTabBucket()).toEqual({ tabs: [{ id: "context", kind: "context" }], activeTabId: "context" });
    expect(addInspectorTab(BUCKET, "browser").activeTabId).toBe("browser");
    expect(addInspectorTab(BUCKET, "terminal").activeTabId).toBe("terminal");
    expect(addInspectorTab(BUCKET, "files")).toEqual(BUCKET);
    expect(activateInspectorTab(BUCKET, "tools").activeTabId).toBe("tools");
  });

  it("chooses the adjacent active tab and supports closing other or all visible tabs", () => {
    expect(closeInspectorTab(BUCKET, "files")).toEqual({
      tabs: [{ id: "context", kind: "context" }, { id: "tools", kind: "tools" }],
      activeTabId: "tools"
    });
    expect(closeOtherInspectorTabs(BUCKET, "files", new Set(["context", "files"]))).toEqual({
      tabs: [{ id: "files", kind: "files" }, { id: "tools", kind: "tools" }],
      activeTabId: "files"
    });
    expect(closeVisibleInspectorTabs(BUCKET, new Set(["context", "files"]))).toEqual({
      tabs: [{ id: "tools", kind: "tools" }], activeTabId: "tools"
    });
  });

  it("projects capability-gated tabs without deleting hidden persisted state", () => {
    const visible = projectInspectorTabBucket(BUCKET, new Set<InspectorTabKind>(["context", "tools"]));
    expect(visible).toEqual({
      tabs: [{ id: "context", kind: "context" }, { id: "tools", kind: "tools" }],
      activeTabId: "context"
    });
    expect(BUCKET.tabs).toHaveLength(3);
  });

  it("reorders only visible slots and provides wrapped keyboard cycling", () => {
    const withHidden: InspectorTabBucket = {
      tabs: [{ id: "context", kind: "context" }, { id: "files", kind: "files" }, { id: "tools", kind: "tools" }],
      activeTabId: "context"
    };
    expect(reorderVisibleInspectorTabs(withHidden, ["tools", "context"]).tabs.map((tab) => tab.id)).toEqual(["tools", "files", "context"]);
    const visible = projectInspectorTabBucket(withHidden, new Set<InspectorTabKind>(["context", "tools"]));
    expect(moveVisibleInspectorTab(withHidden, visible.tabs, "context", 1).tabs.map((tab) => tab.id)).toEqual(["tools", "files", "context"]);
    expect(cycleInspectorTabId(visible.tabs, "tools", 1)).toBe("context");
    expect(cycleInspectorTabId(visible.tabs, "context", -1)).toBe("tools");
  });

  it("round-trips current session state and rejects malformed persisted input as a whole", () => {
    const buckets = { "session-a": BUCKET };
    expect(parseInspectorTabBuckets(serializeInspectorTabBuckets(buckets))).toEqual(buckets);
    expect(parseInspectorTabBuckets("not json")).toEqual({});
    expect(parseInspectorTabBuckets(JSON.stringify({ bad: { tabs: [{ id: "x", kind: "fake" }] } }))).toEqual({});
    expect(parseInspectorTabBuckets('{"__proto__":{"tabs":[]}}')).toEqual({});
    expect(parseInspectorTabBuckets(JSON.stringify({ duplicate: { tabs: [{ id: "same", kind: "context" }, { id: "same", kind: "tools" }], activeTabId: "same" } }))).toEqual({});
    expect(projectInspectorTabBucket(BUCKET, ALL).activeTabId).toBe("files");
  });
});
