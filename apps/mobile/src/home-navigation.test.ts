import { create } from "@bufbuild/protobuf";
import { SessionState, SnapshotSchema, TargetState, WorkspaceKind } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MobileWindowGeometry } from "./mobile-window-geometry";
import {
  FULL_SWIPE_RATIO,
  WIDE_SESSION_NAV_MIN_WIDTH,
  buildMobileHomeSections,
  buildMobileHomeNavigationLayout,
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
  it("uses the ordinary 600dp window gate and clamps the task drawer", () => {
    expect(WIDE_SESSION_NAV_MIN_WIDTH).toBe(600);
    expect(buildWideSessionNavLayout({ windowWidth: 599 })).toEqual({ enabled: false, drawerWidth: 0 });
    expect(buildWideSessionNavLayout({ windowWidth: 600 })).toEqual({ enabled: true, drawerWidth: 300 });
    expect(buildWideSessionNavLayout({ windowWidth: 800 })).toEqual({ enabled: true, drawerWidth: 320 });
    expect(buildWideSessionNavLayout({ windowWidth: 1_366 })).toEqual({ enabled: true, drawerWidth: 360 });
    expect(buildWideSessionNavLayout({ windowWidth: 744 }).enabled).toBe(true);
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

describe("ordinary mobile navigation geometry", () => {
  it("offers quick switching at 600dp while narrow windows retain all detail space", () => {
    expect(buildMobileHomeNavigationLayout({ windowWidth: 599, windowHeight: 800 }))
      .toEqual({ mode: "narrow", drawerWidth: 0, sidebarWidth: 0, sidebarGap: 0, detailWidth: 599 });
    expect(buildMobileHomeNavigationLayout({ windowWidth: 600, windowHeight: 800 }))
      .toEqual({ mode: "drawer", drawerWidth: 300, sidebarWidth: 0, sidebarGap: 0, detailWidth: 600 });
  });

  it("keeps the whole navigation column only when both safe dimensions meet the regular thresholds", () => {
    expect(buildMobileHomeNavigationLayout({ windowWidth: 800, windowHeight: 520,
      safeInsets: { left: 20, right: 20, top: 24, bottom: 16 } }))
      .toEqual({ mode: "persistent", drawerWidth: 0, sidebarWidth: 258, sidebarGap: 0, detailWidth: 502 });
    expect(buildMobileHomeNavigationLayout({ windowWidth: 800, windowHeight: 519,
      safeInsets: { left: 20, right: 20, top: 24, bottom: 16 } }).mode).toBe("drawer");
    expect(buildMobileHomeNavigationLayout({ windowWidth: 800, windowHeight: 520,
      safeInsets: { left: 21, right: 20, top: 24, bottom: 16 } }).mode).toBe("drawer");
  });

  it("returns from persistent to quick or narrow layouts on ordinary resizing and restoration", () => {
    const landscape = { windowWidth: 1_000, windowHeight: 700 };
    expect(buildMobileHomeNavigationLayout(landscape))
      .toEqual({ mode: "persistent", drawerWidth: 0, sidebarWidth: 320, sidebarGap: 0, detailWidth: 680 });
    expect(buildMobileHomeNavigationLayout({ windowWidth: 700, windowHeight: 1_000 }))
      .toEqual({ mode: "drawer", drawerWidth: 300, sidebarWidth: 0, sidebarGap: 0, detailWidth: 700 });
    expect(buildMobileHomeNavigationLayout({ windowWidth: 390, windowHeight: 844 }).mode).toBe("narrow");
    expect(buildMobileHomeNavigationLayout(landscape).mode).toBe("persistent");
  });

  it("does not reserve negative or unmeasured space", () => {
    expect(buildMobileHomeNavigationLayout({ windowWidth: Number.NaN, windowHeight: Number.POSITIVE_INFINITY }))
      .toEqual({ mode: "narrow", drawerWidth: 0, sidebarWidth: 0, sidebarGap: 0, detailWidth: 0 });
    expect(buildMobileHomeNavigationLayout({ windowWidth: 600, windowHeight: 600,
      safeInsets: { left: 800, right: -10, top: Number.NaN } }))
      .toEqual({ mode: "drawer", drawerWidth: 300, sidebarWidth: 0, sidebarGap: 0, detailWidth: 0 });
  });
});

describe("system division navigation", () => {
  const geometry: MobileWindowGeometry = { width: 700, height: 844, insets: { top: 24, left: 10, right: 10, bottom: 20 },
    regularWidth: false, regularHeight: true, barEdge: "left", reservedRegionsSupported: true,
    regions: [{ kind: "division", x: 250, y: 24, width: 20, height: 800 }] };
  it("uses the measured navigation and detail panes even below the ordinary wide gate", () => {
    expect(buildMobileHomeNavigationLayout({ windowWidth: 700, windowHeight: 844, windowGeometry: geometry }))
      .toEqual({ mode: "persistent", drawerWidth: 0, sidebarWidth: 240, sidebarGap: 20, detailWidth: 420 });
  });
  it.each([
    ["navigation too small", { ...geometry, regions: [{ kind: "division", x: 249, y: 24, width: 20, height: 800 }] }],
    ["detail too small", { ...geometry, regions: [{ kind: "division", x: 351, y: 24, width: 20, height: 800 }] }],
    ["horizontal division", { ...geometry, width: 1000, regularWidth: true, regions: [{ kind: "division", x: 10, y: 420, width: 980, height: 20 }] }],
    ["compact width class", { ...geometry, width: 1000, regions: [] }]
  ] as const)("keeps the drawer for %s without inventing a persistent pane", (_name, windowGeometry) => {
    expect(buildMobileHomeNavigationLayout({ windowWidth: windowGeometry.width, windowHeight: windowGeometry.height, windowGeometry }))
      .toMatchObject({ mode: "drawer", sidebarWidth: 0, sidebarGap: 0 });
  });
  it("ignores a partial division and recovers the ordinary layout when the native observation retires", () => {
    const windowGeometry = { ...geometry, width: 1000, regularWidth: true,
      regions: [{ kind: "division" as const, x: 250, y: 24, width: 20, height: 100 }] };
    expect(buildMobileHomeNavigationLayout({ windowWidth: 1000, windowHeight: 844, windowGeometry }))
      .toMatchObject({ mode: "persistent", sidebarWidth: 320, sidebarGap: 0, detailWidth: 660 });
    expect(buildMobileHomeNavigationLayout({ windowWidth: 700, windowHeight: 844 }))
      .toMatchObject({ mode: "drawer", sidebarWidth: 0, sidebarGap: 0, detailWidth: 700 });
  });
});
