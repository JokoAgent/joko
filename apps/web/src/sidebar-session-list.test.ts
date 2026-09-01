import { describe, expect, it } from "vitest";

import {
  SIDEBAR_SESSION_LIST_MINIMUM_VISIBLE,
  SIDEBAR_SESSION_LIST_RECENT_WINDOW_MS,
  sidebarSessionListView
} from "./sidebar-session-list.js";

interface Entry {
  readonly id: string;
  readonly activityAt: number;
  readonly current?: boolean;
  readonly attention?: boolean;
}

const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
const oldActivityAt = nowMs - SIDEBAR_SESSION_LIST_RECENT_WINDOW_MS - 1;

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return { id, activityAt: oldActivityAt, ...overrides };
}

function view(items: readonly Entry[], showAll = false) {
  return sidebarSessionListView({
    items,
    showAll,
    isCurrent: (item) => item.current === true,
    hasAttention: (item) => item.attention === true,
    activityAt: (item) => item.activityAt,
    nowMs
  });
}

describe("sidebar session list view", () => {
  it("shows the first five entries and reports the hidden remainder", () => {
    const result = view(["1", "2", "3", "4", "5", "6"].map((id) => entry(id)));

    expect(result.visibleItems.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(result).toMatchObject({
      totalCount: 6,
      hiddenCount: 1,
      overflowing: true
    });
    expect(SIDEBAR_SESSION_LIST_MINIMUM_VISIBLE).toBe(5);
  });

  it("keeps recent and attention entries visible beyond the first five", () => {
    const items = ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => entry(id));
    items[5] = entry("6", { activityAt: nowMs - 60_000 });
    items[7] = entry("8", { attention: true });

    const result = view(items);

    expect(result.visibleItems.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5", "6", "8"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("expands the complete list when the current entry would be hidden", () => {
    const items = ["1", "2", "3", "4", "5", "6"].map((id) => entry(id, { current: id === "6" }));

    expect(view(items)).toMatchObject({
      visibleItems: items,
      hiddenCount: 0,
      overflowing: false
    });
  });

  it("shows every entry after Show all is selected", () => {
    const items = ["1", "2", "3", "4", "5", "6"].map((id) => entry(id));

    expect(view(items, true)).toMatchObject({
      visibleItems: items,
      hiddenCount: 0,
      overflowing: false
    });
  });
});
