import { create } from "@bufbuild/protobuf";
import { SessionState, SnapshotSchema, TargetState, WorkspaceKind } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  FULL_SWIPE_RATIO,
  WIDE_SESSION_NAV_MIN_WIDTH,
  buildMobileHomeSections,
  buildWideSessionNavLayout,
  createSwipeRowRegistry,
  resolveSwipeRelease,
  shouldClaimHorizontalSwipe,
  shouldCloseDrawer
} from "./home-navigation";

const snapshot = create(SnapshotSchema, {
  generation: 1n,
  targets: [
    { targetId: "project", backendId: "backend", displayName: "Joko source", state: TargetState.ACTIVE },
    { targetId: "dialogue", backendId: "backend", displayName: "General", state: TargetState.ACTIVE }
  ],
  workspaces: [
    { workspaceId: "project-workspace", targetId: "project", displayName: "Joko", kind: WorkspaceKind.USER_PROJECT },
    { workspaceId: "dialogue-workspace", targetId: "dialogue", displayName: "Dialogue", kind: WorkspaceKind.MANAGED_DIALOGUE }
  ],
  sessions: [
    { sessionId: "pinned", backendId: "backend", targetId: "project", displayName: "Pinned task", state: SessionState.IDLE,
      pinned: true, lastActivityAt: { seconds: 20n } },
    { sessionId: "project-new", backendId: "backend", targetId: "project", displayName: "Implementation", state: SessionState.IDLE,
      lastActivityAt: { seconds: 15n } },
    { sessionId: "dialogue", backendId: "backend", targetId: "dialogue", displayName: "Notes", state: SessionState.IDLE,
      lastActivityAt: { seconds: 10n } },
    { sessionId: "archived", backendId: "backend", targetId: "project", displayName: "Old work", state: SessionState.ARCHIVED,
      archived: true, lastActivityAt: { seconds: 30n } },
    { sessionId: "same-b", backendId: "backend", targetId: "project", displayName: "Same B", state: SessionState.IDLE,
      lastActivityAt: { seconds: 5n } },
    { sessionId: "same-a", backendId: "backend", targetId: "project", displayName: "Same A", state: SessionState.IDLE,
      lastActivityAt: { seconds: 5n } }
  ]
});

const labels = { dialogue: "Dialogue", project: "Project", pinned: "Pinned" } as const;

describe("mobile Home presentation", () => {
  it("keeps pinned tasks separate and groups active Dialogue and project tasks in stable recent order", () => {
    const sections = buildMobileHomeSections({ snapshot, statusFilter: "active", query: "", labels });
    expect(sections.map((section) => [section.key, section.items.map((item) => item.session.sessionId)])).toEqual([
      ["pinned", ["pinned"]],
      ["project:project", ["project-new", "same-a", "same-b"]],
      ["dialogue", ["dialogue"]]
    ]);
  });

  it("filters active, archived and all without hiding current message-search matches", () => {
    expect(buildMobileHomeSections({ snapshot, statusFilter: "archived", query: "", messageSessionIds: new Set(), labels })
      .flatMap((section) => section.items.map((item) => item.session.sessionId))).toEqual(["archived"]);
    expect(buildMobileHomeSections({ snapshot, statusFilter: "all", query: "old", messageSessionIds: new Set(), labels })
      .flatMap((section) => section.items.map((item) => item.session.sessionId))).toEqual(["archived"]);
    expect(buildMobileHomeSections({ snapshot, statusFilter: "active", query: "message text", messageSessionIds: new Set(["dialogue", "missing"]), labels })
      .flatMap((section) => section.items.map((item) => item.session.sessionId))).toEqual(["dialogue"]);
  });

  it("matches task and target display names locally", () => {
    expect(buildMobileHomeSections({ snapshot, statusFilter: "active", query: "joko SOURCE", labels })
      .flatMap((section) => section.items.map((item) => item.session.sessionId))).toEqual([
      "pinned", "project-new", "same-a", "same-b"
    ]);
  });

  it("projects caller-owned localized fallback section labels", () => {
    const localized = buildMobileHomeSections({
      snapshot,
      statusFilter: "active",
      query: "",
      labels: { dialogue: "对话", project: "项目", pinned: "已置顶" }
    });
    expect(localized.find((section) => section.key === "pinned")?.title).toBe("已置顶");
    expect(localized.find((section) => section.key === "dialogue")?.title).toBe("对话");
  });
});

describe("mobile navigation and swipe contracts", () => {
  it("uses the 600dp platform gate and clamps the task drawer", () => {
    expect(WIDE_SESSION_NAV_MIN_WIDTH).toBe(600);
    expect(buildWideSessionNavLayout({ platform: "android", windowWidth: 599 })).toEqual({ enabled: false, drawerWidth: 0 });
    expect(buildWideSessionNavLayout({ platform: "android", windowWidth: 600 })).toEqual({ enabled: true, drawerWidth: 300 });
    expect(buildWideSessionNavLayout({ platform: "android", windowWidth: 800 })).toEqual({ enabled: true, drawerWidth: 320 });
    expect(buildWideSessionNavLayout({ platform: "android", windowWidth: 1_366 })).toEqual({ enabled: true, drawerWidth: 360 });
    expect(buildWideSessionNavLayout({ platform: "ios", iosPad: false, windowWidth: 852 }).enabled).toBe(false);
    expect(buildWideSessionNavLayout({ platform: "ios", iosPad: true, windowWidth: 744 }).enabled).toBe(true);
  });

  it("keeps only one swipe row open and lets scrolling close it without triggering an action", () => {
    const registry = createSwipeRowRegistry();
    const closeA = vi.fn();
    const closeB = vi.fn();
    registry.onRowOpen("a", closeA);
    registry.onRowOpen("b", closeB);
    expect(closeA).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(true);
    expect(closeB).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(false);
    registry.onRowClose("a");
  });

  it("executes pin/archive only when release reaches 55 percent", () => {
    expect(FULL_SWIPE_RATIO).toBe(0.55);
    expect(resolveSwipeRelease(219, 400)).toBe("reveal-pin");
    expect(resolveSwipeRelease(220, 400)).toBe("pin");
    expect(resolveSwipeRelease(-219, 400)).toBe("reveal-options");
    expect(resolveSwipeRelease(-220, 400)).toBe("archive");
    expect(resolveSwipeRelease(20, 400)).toBe("close");
  });

  it("claims only intentional horizontal gestures and closes drawers on a left release", () => {
    expect(shouldClaimHorizontalSwipe(12, 3)).toBe(true);
    expect(shouldClaimHorizontalSwipe(5, 1)).toBe(false);
    expect(shouldClaimHorizontalSwipe(12, 12)).toBe(false);
    expect(shouldCloseDrawer(-80, 0, 320)).toBe(true);
    expect(shouldCloseDrawer(-10, -0.7, 320)).toBe(true);
    expect(shouldCloseDrawer(-20, -0.2, 320)).toBe(false);
  });
});
