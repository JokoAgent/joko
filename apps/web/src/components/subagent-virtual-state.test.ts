import { describe, expect, it } from "vitest";

import {
  countUnreadSubagentItems,
  nextSubagentTabIndex,
  resolveSubagentAnchorIndex,
  resolveSubagentFollowingOnScroll,
  SUBAGENT_LIVE_EDGE_DISTANCE_PX
} from "./subagent-virtual-state.js";

describe("managed subagent virtual state", () => {
  it("follows only inside the 100px live edge and detaches on upward history motion", () => {
    expect(resolveSubagentFollowingOnScroll({ distanceFromEnd: SUBAGENT_LIVE_EDGE_DISTANCE_PX, scrollDelta: 1 })).toBe(true);
    expect(resolveSubagentFollowingOnScroll({ distanceFromEnd: SUBAGENT_LIVE_EDGE_DISTANCE_PX - 1, scrollDelta: -1 })).toBe(false);
    expect(resolveSubagentFollowingOnScroll({ distanceFromEnd: SUBAGENT_LIVE_EDGE_DISTANCE_PX + 1, scrollDelta: -1 })).toBe(false);
    expect(resolveSubagentFollowingOnScroll({ distanceFromEnd: 900, scrollDelta: 20 })).toBe(false);
  });

  it("restores a durable anchor or its nearest surviving successor after a full reread", () => {
    const anchor = { itemId: "second", index: 1, offset: 24 };
    expect(resolveSubagentAnchorIndex(["first", "second", "third"], anchor)).toBe(1);
    expect(resolveSubagentAnchorIndex(["first", "replacement", "third"], anchor)).toBe(1);
    expect(resolveSubagentAnchorIndex(["third", "fourth"], anchor, ["first", "second", "third", "fourth"])).toBe(0);
    expect(resolveSubagentAnchorIndex(["first"], anchor)).toBe(0);
    expect(resolveSubagentAnchorIndex([], anchor)).toBeUndefined();
  });

  it("counts only unseen rows at or after the detached anchor", () => {
    const known = new Set(["old-before", "anchor", "old-after"]);
    expect(countUnreadSubagentItems(known, ["new-before", "anchor", "old-after", "new-after"], {
      itemId: "anchor",
      index: 1,
      offset: 0
    })).toBe(1);
  });

  it("provides wrapping arrow navigation and absolute Home/End navigation for child tabs", () => {
    expect(nextSubagentTabIndex(0, 4, "ArrowLeft")).toBe(3);
    expect(nextSubagentTabIndex(3, 4, "ArrowRight")).toBe(0);
    expect(nextSubagentTabIndex(2, 4, "Home")).toBe(0);
    expect(nextSubagentTabIndex(1, 4, "End")).toBe(3);
    expect(nextSubagentTabIndex(1, 4, "Escape")).toBeUndefined();
  });
});
