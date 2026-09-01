import { describe, expect, it, vi } from "vitest";

import {
  DesktopAttentionBadgeController,
  parseDesktopAttentionKey,
  type DesktopAttentionPresentation
} from "../src/attention-badge.js";

describe("Desktop attention badge", () => {
  it("accepts only credential-free bounded exact owner/task keys", () => {
    const key = parseDesktopAttentionKey({ ownerId: "owner-a", sessionId: "task-a" });
    expect(key).toEqual({ ownerId: "owner-a", sessionId: "task-a" });
    expect(Object.isFrozen(key)).toBe(true);
    expect(() => parseDesktopAttentionKey({ ownerId: "owner-a", sessionId: "task-a", extra: true })).toThrow(/only ownerId and sessionId/u);
    expect(() => parseDesktopAttentionKey({ ownerId: " owner-a", sessionId: "task-a" })).toThrow(/bounded exact/u);
    expect(() => parseDesktopAttentionKey({ ownerId: "owner-a", sessionId: "x".repeat(257) })).toThrow(/bounded exact/u);
  });

  it("keeps exact source-owned attention while foreground only clears native presentation", () => {
    const show = vi.fn<DesktopAttentionPresentation["show"]>();
    const clear = vi.fn<DesktopAttentionPresentation["clear"]>();
    const controller = new DesktopAttentionBadgeController({ show, clear }, 2);
    const first = parseDesktopAttentionKey({ ownerId: "owner", sessionId: "one" });
    const second = parseDesktopAttentionKey({ ownerId: "owner", sessionId: "two" });

    controller.mark(1, first);
    expect(controller.count).toBe(1);
    expect(show).not.toHaveBeenCalled();
    controller.setForeground(false);
    expect(show).toHaveBeenLastCalledWith(1, false);
    controller.mark(1, second);
    expect(show).toHaveBeenLastCalledWith(2, true);

    controller.setForeground(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(controller.count).toBe(2);
    controller.setForeground(false);
    expect(show).toHaveBeenLastCalledWith(2, false);

    controller.clear(1, first);
    expect(controller.count).toBe(1);
    controller.releaseSource(1);
    expect(controller.count).toBe(0);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("deduplicates exact keys across renderers and bounds unique native state", () => {
    const controller = new DesktopAttentionBadgeController({ show: vi.fn(), clear: vi.fn() }, 1);
    const shared = parseDesktopAttentionKey({ ownerId: "owner", sessionId: "same" });
    const other = parseDesktopAttentionKey({ ownerId: "owner", sessionId: "other" });
    controller.mark(1, shared);
    controller.mark(2, shared);
    expect(controller.count).toBe(1);
    controller.releaseSource(1);
    expect(controller.count).toBe(1);
    expect(() => controller.mark(2, other)).toThrow(/capacity/u);
    controller.clear(2, shared);
    controller.mark(2, other);
    expect(controller.count).toBe(1);
  });

  it("fails closed when a native presentation is unavailable without losing projected state", () => {
    const clear = vi.fn();
    const controller = new DesktopAttentionBadgeController({
      clear,
      show: () => { throw new Error("unsupported"); }
    });
    controller.mark(1, parseDesktopAttentionKey({ ownerId: "owner", sessionId: "task" }));
    expect(() => controller.setForeground(false)).not.toThrow();
    expect(clear).toHaveBeenCalledOnce();
    expect(controller.count).toBe(1);
  });

});
