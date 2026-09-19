export interface ComposerResizeBounds {
  readonly minimumHeight: number;
  readonly maximumHeight: number;
}

export interface ComposerHeightModel {
  readonly mode: "automatic" | "manual";
  readonly visibleHeight: number;
  readonly scrollEnabled: boolean;
}

export const composerMinimumInputHeight = 44;
export const composerAutomaticMaximumHeight = 144;
export const composerResizeTopReserve = 220;
export const composerResizeSnapThreshold = 24;
export const composerResizeDismissThreshold = 24;
export const composerResizeStep = 44;

export function computeComposerResizeBounds(input: {
  readonly windowHeight: number;
  readonly keyboardHeight: number;
  readonly minimumHeight?: number;
  readonly automaticMaximumHeight?: number;
  readonly composerChromeHeight: number;
}): ComposerResizeBounds {
  const minimumHeight = positive(input.minimumHeight, composerMinimumInputHeight);
  const automaticMaximumHeight = Math.max(
    minimumHeight,
    positive(input.automaticMaximumHeight, composerAutomaticMaximumHeight)
  );
  const windowHeight = positive(input.windowHeight, 812);
  const keyboardHeight = nonNegative(input.keyboardHeight, 0);
  const available = windowHeight - keyboardHeight - composerResizeTopReserve
    - nonNegative(input.composerChromeHeight, 0);
  return {
    minimumHeight: Math.round(minimumHeight),
    maximumHeight: Math.max(Math.round(minimumHeight), Math.round(automaticMaximumHeight), Math.round(available))
  };
}

export function resolveComposerHeight(input: {
  readonly contentHeight: number;
  readonly manualHeight: number | null;
  readonly automaticMaximumHeight?: number;
  readonly bounds: ComposerResizeBounds;
}): ComposerHeightModel {
  const bounds = normalizeBounds(input.bounds);
  const automaticMaximum = clamp(
    positive(input.automaticMaximumHeight, composerAutomaticMaximumHeight),
    bounds.minimumHeight,
    bounds.maximumHeight
  );
  if (input.manualHeight === null) {
    return {
      mode: "automatic",
      visibleHeight: clamp(nonNegative(input.contentHeight, bounds.minimumHeight), bounds.minimumHeight, automaticMaximum),
      // Native TextInput must be ready to scroll even when onContentSizeChange
      // arrives a frame late after the content crosses the cap.
      scrollEnabled: true
    };
  }
  return {
    mode: "manual",
    visibleHeight: clamp(input.manualHeight, bounds.minimumHeight, bounds.maximumHeight),
    scrollEnabled: true
  };
}

export function resizeComposerHeight(input: {
  readonly startHeight: number;
  readonly translationY: number;
  readonly bounds: ComposerResizeBounds;
}): number {
  const bounds = normalizeBounds(input.bounds);
  return clamp(Math.round(input.startHeight - input.translationY), bounds.minimumHeight, bounds.maximumHeight);
}

export function settleComposerHeight(input: {
  readonly draggedHeight: number;
  readonly contentHeight: number;
  readonly bounds: ComposerResizeBounds;
}): number | null {
  const bounds = normalizeBounds(input.bounds);
  const dragged = clamp(Math.round(input.draggedHeight), bounds.minimumHeight, bounds.maximumHeight);
  if (dragged > bounds.minimumHeight + composerResizeSnapThreshold) return dragged;
  return input.contentHeight <= bounds.minimumHeight + composerResizeSnapThreshold
    ? null
    : bounds.minimumHeight;
}

export function shouldDismissComposerKeyboard(input: {
  readonly draggedHeight: number;
  readonly translationY: number;
  readonly bounds: ComposerResizeBounds;
}): boolean {
  const bounds = normalizeBounds(input.bounds);
  return input.translationY >= composerResizeDismissThreshold
    && input.draggedHeight <= bounds.minimumHeight + composerResizeSnapThreshold;
}

export function accessibleComposerHeight(input: {
  readonly currentHeight: number;
  readonly direction: "increase" | "decrease" | "automatic";
  readonly bounds: ComposerResizeBounds;
}): number | null {
  const bounds = normalizeBounds(input.bounds);
  if (input.direction === "automatic") return null;
  const delta = input.direction === "increase" ? composerResizeStep : -composerResizeStep;
  const next = clamp(input.currentHeight + delta, bounds.minimumHeight, bounds.maximumHeight);
  return input.direction === "decrease" && next <= bounds.minimumHeight ? null : next;
}

export function shouldClaimComposerResizeGesture(gesture: { readonly dx: number; readonly dy: number }): boolean {
  return Math.abs(gesture.dy) > 3 && Math.abs(gesture.dy) > Math.abs(gesture.dx);
}

export function buildComposerResizeGestureConfig(callbacks: {
  readonly onGrant: () => void;
  readonly onMove: (translationY: number) => void;
  readonly onEnd: (translationY: number) => void;
}) {
  return {
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_event: unknown, gesture: { dx: number; dy: number }) => shouldClaimComposerResizeGesture(gesture),
    onMoveShouldSetPanResponderCapture: (_event: unknown, gesture: { dx: number; dy: number }) => shouldClaimComposerResizeGesture(gesture),
    onPanResponderGrant: callbacks.onGrant,
    onPanResponderMove: (_event: unknown, gesture: { dy: number }) => callbacks.onMove(gesture.dy),
    onPanResponderRelease: (_event: unknown, gesture: { dy: number }) => callbacks.onEnd(gesture.dy),
    onPanResponderTerminate: (_event: unknown, gesture: { dy: number }) => callbacks.onEnd(gesture.dy),
    onPanResponderTerminationRequest: () => false
  };
}

function normalizeBounds(bounds: ComposerResizeBounds): ComposerResizeBounds {
  const minimumHeight = Math.max(1, Math.round(bounds.minimumHeight));
  return {
    minimumHeight,
    maximumHeight: Math.max(minimumHeight, Math.round(bounds.maximumHeight))
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
