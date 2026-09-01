// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  TIMELINE_UNPIN_SCROLLABLE_TOLERANCE_PX,
  hasNestedTimelineScrollerThatCanMoveUp,
  isEditableTimelineKeyboardTarget,
  shouldUnpinTimelineOnUpIntent,
  shouldUnpinTimelineOnWheel
} from "./timeline-follow-intent.js";

const SCROLLABLE = { scrollHeight: 2_000, clientHeight: 800 };

describe("timeline follow intent", () => {
  it("unpins for any vertical-primary upward wheel intent", () => {
    expect(shouldUnpinTimelineOnWheel({ deltaX: 0, deltaY: -1, ...SCROLLABLE })).toBe(true);
    expect(shouldUnpinTimelineOnWheel({ deltaX: 40, deltaY: -40, ...SCROLLABLE })).toBe(true);
  });

  it("ignores downward, horizontal, and horizontal-primary wheel movement", () => {
    expect(shouldUnpinTimelineOnWheel({ deltaX: 0, deltaY: 40, ...SCROLLABLE })).toBe(false);
    expect(shouldUnpinTimelineOnWheel({ deltaX: -30, deltaY: 0, ...SCROLLABLE })).toBe(false);
    expect(shouldUnpinTimelineOnWheel({ deltaX: 60, deltaY: -3, ...SCROLLABLE })).toBe(false);
  });

  it("does not detach before the timeline has a real scroll range", () => {
    const rounded = { scrollHeight: 800 + TIMELINE_UNPIN_SCROLLABLE_TOLERANCE_PX, clientHeight: 800 };
    expect(shouldUnpinTimelineOnWheel({ deltaX: 0, deltaY: -40, ...rounded })).toBe(false);
    expect(shouldUnpinTimelineOnUpIntent(rounded)).toBe(false);
    expect(shouldUnpinTimelineOnUpIntent(SCROLLABLE)).toBe(true);
  });

  it("leaves upward movement with a nested scroller that can consume it", () => {
    const root = document.createElement("div");
    const nested = document.createElement("div");
    const child = document.createElement("span");
    root.append(nested);
    nested.append(child);
    document.body.append(root);
    nested.style.overflowY = "auto";
    Object.defineProperties(nested, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 20 }
    });
    expect(hasNestedTimelineScrollerThatCanMoveUp(root, child)).toBe(true);
    Object.defineProperty(nested, "scrollTop", { configurable: true, value: 1 });
    expect(hasNestedTimelineScrollerThatCanMoveUp(root, child)).toBe(false);
    root.remove();
  });

  it("yields history-navigation keys to editable controls", () => {
    expect(isEditableTimelineKeyboardTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTimelineKeyboardTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTimelineKeyboardTarget(document.createElement("select"))).toBe(true);
    expect(isEditableTimelineKeyboardTarget(document.createElement("button"))).toBe(false);
  });
});
