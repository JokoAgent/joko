import { describe, expect, it, vi } from "vitest";
import {
  accessibleComposerHeight,
  buildComposerResizeGestureConfig,
  composerAutomaticMaximumHeight,
  composerMinimumInputHeight,
  composerResizeTopReserve,
  computeComposerResizeBounds,
  resizeComposerHeight,
  resolveComposerHeight,
  settleComposerHeight,
  shouldDismissComposerKeyboard
} from "./composer-layout";

const bounds = { minimumHeight: 44, maximumHeight: 400 };

describe("mobile composer height", () => {
  it("grows automatically to its cap and keeps native scrolling ready", () => {
    expect(resolveComposerHeight({ contentHeight: 96, manualHeight: null, bounds })).toEqual({
      mode: "automatic", visibleHeight: 96, scrollEnabled: true
    });
    expect(resolveComposerHeight({ contentHeight: 300, manualHeight: null, bounds }).visibleHeight)
      .toBe(composerAutomaticMaximumHeight);
    expect(resolveComposerHeight({ contentHeight: 0, manualHeight: null, bounds }).visibleHeight)
      .toBe(composerMinimumInputHeight);
  });

  it("keeps manual mode while re-clamping to a smaller keyboard or rotation bound", () => {
    expect(resolveComposerHeight({
      contentHeight: 80,
      manualHeight: 360,
      bounds: { minimumHeight: 44, maximumHeight: 220 }
    })).toEqual({ mode: "manual", visibleHeight: 220, scrollEnabled: true });
  });

  it("derives the manual ceiling from current window and keyboard geometry", () => {
    const visible = computeComposerResizeBounds({ windowHeight: 900, keyboardHeight: 300, composerChromeHeight: 60 });
    const hidden = computeComposerResizeBounds({ windowHeight: 900, keyboardHeight: 0, composerChromeHeight: 60 });
    expect(visible.maximumHeight).toBe(900 - 300 - composerResizeTopReserve - 60);
    expect(hidden.maximumHeight).toBeGreaterThan(visible.maximumHeight);
  });

  it("drags upward to grow, clamps, and settles near one line back to automatic", () => {
    expect(resizeComposerHeight({ startHeight: 100, translationY: -80, bounds })).toBe(180);
    expect(resizeComposerHeight({ startHeight: 100, translationY: 800, bounds })).toBe(44);
    expect(settleComposerHeight({ draggedHeight: 44, contentHeight: 44, bounds })).toBeNull();
    expect(settleComposerHeight({ draggedHeight: 44, contentHeight: 100, bounds })).toBe(44);
    expect(shouldDismissComposerKeyboard({ draggedHeight: 44, translationY: 30, bounds })).toBe(true);
  });

  it("offers equivalent accessible resize and reset actions", () => {
    expect(accessibleComposerHeight({ currentHeight: 100, direction: "increase", bounds })).toBe(144);
    expect(accessibleComposerHeight({ currentHeight: 80, direction: "decrease", bounds })).toBeNull();
    expect(accessibleComposerHeight({ currentHeight: 200, direction: "automatic", bounds })).toBeNull();
  });

  it("claims the dedicated handle and routes release and forced termination", () => {
    const onGrant = vi.fn();
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const handlers = buildComposerResizeGestureConfig({ onGrant, onMove, onEnd });
    expect(handlers.onStartShouldSetPanResponder()).toBe(true);
    expect(handlers.onMoveShouldSetPanResponder(null, { dx: 1, dy: 8 })).toBe(true);
    expect(handlers.onMoveShouldSetPanResponderCapture(null, { dx: 12, dy: 4 })).toBe(false);
    expect(handlers.onPanResponderTerminationRequest()).toBe(false);
    handlers.onPanResponderGrant();
    handlers.onPanResponderMove(null, { dy: -30 });
    handlers.onPanResponderRelease(null, { dy: -30 });
    handlers.onPanResponderTerminate(null, { dy: 12 });
    expect(onGrant).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith(-30);
    expect(onEnd.mock.calls).toEqual([[-30], [12]]);
  });
});
