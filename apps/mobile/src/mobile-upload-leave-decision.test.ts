import { describe, expect, it, vi } from "vitest";
import { MobileUploadLeaveDecision } from "./mobile-upload-leave-decision";

describe("attachment upload leave decision", () => {
  it.each([false, true])("holds dispatch while the leave dialog is open and resolves discard=%s", async discard => {
    const decision = new MobileUploadLeaveDecision(), leave = vi.fn();
    let settle!: (discard: boolean) => void;
    const show = vi.fn((resolve: (discard: boolean) => void) => { settle = resolve; });
    decision.requestLeave(show, leave); decision.requestLeave(show, leave);
    let resolved = false;
    const waiting = decision.waitForLeaveDecision().then(value => { resolved = true; return value; });
    await Promise.resolve(); expect(resolved).toBe(false); expect(show).toHaveBeenCalledOnce();
    settle(discard); settle(!discard);
    expect(await waiting).toBe(discard); expect(await decision.waitForLeaveDecision()).toBe(discard);
    expect(leave).toHaveBeenCalledTimes(discard ? 1 : 0); expect(decision.controller.signal.aborted).toBe(discard);
  });

  it("retires an unresolved dialog when its screen leaves", async () => {
    const decision = new MobileUploadLeaveDecision(), leave = vi.fn();
    let settle!: (discard: boolean) => void;
    decision.requestLeave(resolve => { settle = resolve; }, leave);
    const waiting = decision.waitForLeaveDecision(); decision.dispose(); settle(false);
    expect(await waiting).toBe(true); expect(decision.controller.signal.aborted).toBe(true); expect(leave).not.toHaveBeenCalled();
  });
});
