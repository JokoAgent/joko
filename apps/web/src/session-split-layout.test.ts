// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_SESSION_SPLIT_PANES,
  addSessionSplit,
  clearSessionSplitLayoutForTests,
  normalizeSessionSplitLayout,
  readSessionSplitLayout,
  reconcileSessionSplit,
  removeSessionSplit,
  replaceSessionSplit,
  resizeSessionSplit,
  sessionSplitPanes,
  writeSessionSplitLayout
} from "./session-split-layout.js";

describe("session split layout", () => {
  beforeEach(() => {
    localStorage.clear();
    clearSessionSplitLayoutForTests();
    vi.restoreAllMocks();
  });

  it("builds a recursive four-side tree and collapses unary branches", () => {
    let layout = addSessionSplit({}, "session-b", "session-a", "right");
    layout = addSessionSplit(layout, "session-c", "session-b", "bottom");
    layout = addSessionSplit(layout, "session-d", "session-c", "left");
    expect(sessionSplitPanes(layout.root).map((pane) => pane.sessionId)).toEqual([
      "session-a",
      "session-b",
      "session-d",
      "session-c"
    ]);
    layout = removeSessionSplit(layout, "session-b");
    expect(sessionSplitPanes(layout.root).map((pane) => pane.sessionId)).toEqual([
      "session-a",
      "session-d",
      "session-c"
    ]);
    layout = removeSessionSplit(layout, "session-a");
    layout = removeSessionSplit(layout, "session-d");
    expect(layout).toEqual({});
  });

  it("rejects duplicates, missing anchors, and panes beyond the bounded maximum", () => {
    let layout = addSessionSplit({}, "session-2", "session-1", "right");
    expect(addSessionSplit(layout, "session-2", "session-1", "left")).toBe(layout);
    expect(addSessionSplit(layout, "session-3", "missing", "left")).toBe(layout);
    for (let index = 3; index <= MAXIMUM_SESSION_SPLIT_PANES; index += 1) {
      layout = addSessionSplit(layout, `session-${index}`, "session-1", "right");
    }
    expect(sessionSplitPanes(layout.root)).toHaveLength(MAXIMUM_SESSION_SPLIT_PANES);
    expect(addSessionSplit(layout, "session-overflow", "session-1", "right")).toBe(layout);
  });

  it("clamps resize, replaces only a unique pane, and reconciles deleted sessions", () => {
    let layout = addSessionSplit({}, "session-b", "session-a", "bottom");
    const splitKey = layout.root?.key ?? "";
    layout = resizeSessionSplit(layout, splitKey, 99);
    expect(layout.root?.kind === "split" ? layout.root.ratio : undefined).toBe(0.9);
    layout = replaceSessionSplit(layout, "session-b", "session-c");
    expect(sessionSplitPanes(layout.root).map((pane) => pane.sessionId)).toEqual(["session-a", "session-c"]);
    expect(replaceSessionSplit(layout, "session-a", "session-c")).toBe(layout);
    expect(reconcileSessionSplit(layout, new Set(["session-c"]))).toEqual({});
  });

  it("rejects persisted trees outside the current complete shape", () => {
    const corrupt = {
      version: 1,
      root: {
        kind: "split",
        key: "same",
        axis: "column",
        ratio: -5,
        first: { kind: "pane", key: "same", sessionId: " session-a " },
        second: {
          kind: "split",
          key: "same",
          ratio: Number.NaN,
          first: { kind: "pane", key: "p", sessionId: "session-a" },
          second: { kind: "pane", key: "p", sessionId: "session-b" }
        }
      }
    };
    expect(normalizeSessionSplitLayout(corrupt)).toEqual({});
    expect(normalizeSessionSplitLayout({ version: 2, root: corrupt.root })).toEqual({});
    expect(normalizeSessionSplitLayout({ root: corrupt.root })).toEqual({});
  });

  it("partitions layouts by owner and retains an in-memory fallback when storage is blocked", () => {
    const layoutA = addSessionSplit({}, "session-b", "session-a", "right");
    writeSessionSplitLayout("owner-a", layoutA);
    expect(sessionSplitPanes(readSessionSplitLayout("owner-a").root)).toHaveLength(2);
    expect(readSessionSplitLayout("owner-b")).toEqual({});

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    writeSessionSplitLayout("owner-c", layoutA);
    expect(setItem).toHaveBeenCalled();
    expect(sessionSplitPanes(readSessionSplitLayout("owner-c").root)).toHaveLength(2);
  });
});
