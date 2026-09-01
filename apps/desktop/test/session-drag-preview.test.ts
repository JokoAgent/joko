import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isDesktopSessionDragPreviewRequest,
  type DesktopSessionDragPreviewRequest
} from "../src/channels.js";
import {
  buildSessionDragPreviewDocument,
  SESSION_DRAG_NATIVE_RESULT_TTL_MS,
  SESSION_DRAG_PREVIEW_INTERVAL_MS,
  SESSION_DRAG_PREVIEW_TIMEOUT_MS,
  SessionDragNativeResultFence,
  SessionDragPreviewCoordinator,
  type NativeSessionDragPreviewWindow
} from "../src/session-drag-preview.js";
import type { DesktopPoint, DesktopRectangle } from "../src/session-window-drop.js";

afterEach(() => vi.useRealTimers());

describe("native task drag preview", () => {
  it("follows the native cursor across displays and appears only outside application windows", () => {
    vi.useFakeTimers();
    const environment = previewEnvironment();
    const preview = new PreviewWindow();
    const coordinator = new SessionDragPreviewCoordinator(environment);

    expect(coordinator.begin({}, request(), preview)).toBe(true);
    expect(preview.showCalls).toBe(0);

    environment.point = { x: -10, y: 1070 };
    vi.advanceTimersByTime(SESSION_DRAG_PREVIEW_INTERVAL_MS);
    expect(preview.bounds).toEqual({ x: -320, y: 1012, width: 320, height: 68 });
    expect(preview.showCalls).toBe(1);

    environment.point = { x: 200, y: 200 };
    vi.advanceTimersByTime(SESSION_DRAG_PREVIEW_INTERVAL_MS);
    expect(preview.hideCalls).toBe(1);
  });

  it("keeps a single owner fence and consumes an outside release exactly once", () => {
    vi.useFakeTimers();
    const environment = previewEnvironment();
    environment.point = { x: -800, y: 500 };
    const coordinator = new SessionDragPreviewCoordinator(environment);
    const firstOwner = {};
    const secondOwner = {};
    const first = new PreviewWindow();
    const rejected = new PreviewWindow();
    expect(coordinator.begin(firstOwner, request(), first)).toBe(true);
    expect(coordinator.begin(secondOwner, { ...request(), gestureId: "gesture_second_0002" }, rejected)).toBe(false);
    expect(rejected.destroyCalls).toBe(0);
    expect(coordinator.end(secondOwner, "gesture_owner_0001")).toBe(false);

    expect(coordinator.finish(firstOwner, "gesture_owner_0001")).toEqual({
      kind: "outside",
      point: { x: -800, y: 500 },
      sessionId: "task-one"
    });
    expect(first.destroyCalls).toBe(1);
    expect(coordinator.finish(firstOwner, "gesture_owner_0001")).toBeUndefined();
  });

  it("lets one trusted native release classify and close the active gesture", () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const environment = { ...previewEnvironment(), onStop };
    environment.point = { x: -500, y: 400 };
    const coordinator = new SessionDragPreviewCoordinator(environment);
    const preview = new PreviewWindow();
    const owner = {};
    coordinator.begin(owner, request(), preview);

    expect(coordinator.finishNativeRelease()).toEqual({
      kind: "outside",
      point: { x: -500, y: 400 },
      sessionId: "task-one",
      owner,
      gestureId: "gesture_owner_0001"
    });
    expect(coordinator.finishNativeRelease()).toBeUndefined();
    expect(preview.destroyCalls).toBe(1);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("returns one successful native open result to the matching renderer without retrying", async () => {
    vi.useFakeTimers();
    const owner = {};
    const firstAttempt = vi.fn().mockResolvedValue({ focusedExisting: false });
    const retry = vi.fn().mockResolvedValue({ focusedExisting: true });
    const fence = new SessionDragNativeResultFence<object, { readonly focusedExisting: boolean }>();
    fence.start({ owner, gestureId: "gesture_owner_0001", firstAttempt, retry });

    await expect(fence.consume(owner, "gesture_owner_0001")).resolves.toEqual({ focusedExisting: false });
    await expect(fence.consume(owner, "gesture_owner_0001")).resolves.toBeUndefined();
    expect(firstAttempt).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("waits for a failed native open and gives the matching renderer exactly one retry", async () => {
    vi.useFakeTimers();
    const owner = {};
    let rejectFirst: ((reason: Error) => void) | undefined;
    const firstAttempt = vi.fn(() => new Promise<{ readonly focusedExisting: boolean }>((_resolve, reject) => {
      rejectFirst = reject;
    }));
    const retry = vi.fn().mockResolvedValue({ focusedExisting: true });
    const fence = new SessionDragNativeResultFence<object, { readonly focusedExisting: boolean }>();
    fence.start({ owner, gestureId: "gesture_owner_0001", firstAttempt, retry });
    const consuming = fence.consume(owner, "gesture_owner_0001");
    rejectFirst?.(new Error("first open failed"));

    await expect(consuming).resolves.toEqual({ focusedExisting: true });
    expect(retry).toHaveBeenCalledOnce();
    await expect(fence.consume(owner, "gesture_owner_0001")).resolves.toBeUndefined();
  });

  it("does not expose a native result to a different owner or gesture", async () => {
    vi.useFakeTimers();
    const owner = {};
    const otherOwner = {};
    const fence = new SessionDragNativeResultFence<object, string>();
    fence.start({
      owner,
      gestureId: "gesture_owner_0001",
      firstAttempt: async () => "opened",
      retry: async () => "retried"
    });

    await expect(fence.consume(otherOwner, "gesture_owner_0001")).resolves.toBeUndefined();
    await expect(fence.consume(owner, "gesture_other_0002")).resolves.toBeUndefined();
    await expect(fence.consume(owner, "gesture_owner_0001")).resolves.toBe("opened");
  });

  it("expires or owner-clears an unconsumed native result and releases its listeners", async () => {
    vi.useFakeTimers();
    const owner = {};
    const onTtlClear = vi.fn();
    const fence = new SessionDragNativeResultFence<object, string>();
    fence.start({
      owner,
      gestureId: "gesture_owner_0001",
      firstAttempt: () => new Promise(() => undefined),
      retry: async () => "retried",
      onClear: onTtlClear
    });
    const expiringConsume = fence.consume(owner, "gesture_owner_0001");
    vi.advanceTimersByTime(SESSION_DRAG_NATIVE_RESULT_TTL_MS);
    await expect(expiringConsume).resolves.toBeUndefined();
    expect(onTtlClear).toHaveBeenCalledOnce();

    const onOwnerClear = vi.fn();
    fence.start({
      owner,
      gestureId: "gesture_owner_0002",
      firstAttempt: async () => "opened",
      retry: async () => "retried",
      onClear: onOwnerClear
    });
    expect(fence.endOwner({})).toBe(false);
    expect(fence.endOwner(owner)).toBe(true);
    await expect(fence.consume(owner, "gesture_owner_0002")).resolves.toBeUndefined();
    expect(onOwnerClear).toHaveBeenCalledOnce();

    let rejectAfterOwnerLoss: ((reason: Error) => void) | undefined;
    const retryAfterOwnerLoss = vi.fn().mockResolvedValue("retried");
    fence.start({
      owner,
      gestureId: "gesture_owner_0003",
      firstAttempt: () => new Promise<string>((_resolve, reject) => { rejectAfterOwnerLoss = reject; }),
      retry: retryAfterOwnerLoss
    });
    const ownerLostConsume = fence.consume(owner, "gesture_owner_0003");
    expect(fence.endOwner(owner)).toBe(true);
    rejectAfterOwnerLoss?.(new Error("owner closed"));
    await expect(ownerLostConsume).resolves.toBeUndefined();
    expect(retryAfterOwnerLoss).not.toHaveBeenCalled();
  });

  it("replaces a gesture only for the same owner and cleans up on owner loss or timeout", () => {
    vi.useFakeTimers();
    const environment = previewEnvironment();
    const coordinator = new SessionDragPreviewCoordinator(environment);
    const owner = {};
    const first = new PreviewWindow();
    const second = new PreviewWindow();
    coordinator.begin(owner, request(), first);
    coordinator.begin(owner, { ...request(), gestureId: "gesture_second_0002" }, second);
    expect(first.destroyCalls).toBe(1);
    expect(coordinator.endOwner(owner)).toBe(true);
    expect(second.destroyCalls).toBe(1);

    const timed = new PreviewWindow();
    coordinator.begin(owner, { ...request(), gestureId: "gesture_timeout_0003" }, timed);
    vi.advanceTimersByTime(SESSION_DRAG_PREVIEW_TIMEOUT_MS);
    expect(timed.destroyCalls).toBe(1);
    expect(coordinator.finish(owner, "gesture_timeout_0003")).toBeUndefined();
  });

  it("validates exact bounded input and escapes preview copy", () => {
    const safe = request({ label: "<img src=x>", hint: "Open & focus" });
    expect(isDesktopSessionDragPreviewRequest(safe)).toBe(true);
    const document = buildSessionDragPreviewDocument(safe);
    expect(document).toContain("&lt;img src=x&gt;");
    expect(document).toContain("Open &amp; focus");
    expect(document).not.toContain("<img src=x>");
    expect(document).toContain("default-src 'none'");

    expect(isDesktopSessionDragPreviewRequest({ ...safe, extra: true })).toBe(false);
    expect(isDesktopSessionDragPreviewRequest({
      ...safe,
      palette: { ...safe.palette, surface: "red;position:fixed" }
    })).toBe(false);
  });
});

class PreviewWindow implements NativeSessionDragPreviewWindow {
  bounds: DesktopRectangle | undefined;
  destroyed = false;
  showCalls = 0;
  hideCalls = 0;
  destroyCalls = 0;

  isDestroyed(): boolean { return this.destroyed; }
  setBounds(bounds: DesktopRectangle): void { this.bounds = bounds; }
  showInactive(): void { this.showCalls += 1; }
  hide(): void { this.hideCalls += 1; }
  destroy(): void { this.destroyCalls += 1; this.destroyed = true; }
}

function previewEnvironment(): {
  point: DesktopPoint;
  getCursorPoint(): DesktopPoint;
  getWorkArea(point: DesktopPoint): DesktopRectangle;
  getVisibleApplicationBounds(): readonly DesktopRectangle[];
} {
  return {
    point: { x: 200, y: 200 },
    getCursorPoint() { return this.point; },
    getWorkArea(point) {
      return point.x < 0
        ? { x: -1920, y: 0, width: 1920, height: 1080 }
        : { x: 0, y: 0, width: 1920, height: 1080 };
    },
    getVisibleApplicationBounds() { return [{ x: 100, y: 100, width: 800, height: 600 }]; }
  };
}

function request(overrides: Partial<DesktopSessionDragPreviewRequest> = {}): DesktopSessionDragPreviewRequest {
  return {
    gestureId: "gesture_owner_0001",
    sessionId: "task-one",
    label: "Task one",
    hint: "Open in new window",
    palette: {
      surface: "rgb(255, 255, 255)",
      border: "rgb(216, 216, 216)",
      text: "rgb(13, 13, 13)",
      muted: "rgb(95, 95, 95)",
      accent: "rgb(255, 152, 0)"
    },
    ...overrides
  };
}
