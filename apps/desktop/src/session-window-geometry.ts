import type { DesktopRectangle } from "./session-window-drop.js";
import type { WindowGeometryDefaults } from "./window-layout-reset.js";

export interface SessionWindowInitialBounds extends WindowGeometryDefaults {
  readonly x?: number;
  readonly y?: number;
}

/** Each new Task window derives its geometry from its live initiating window. */
export function sessionWindowInitialBounds(
  sourceBounds: DesktopRectangle | undefined,
  defaults: WindowGeometryDefaults
): SessionWindowInitialBounds {
  const size = sourceBounds ?? defaults;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0
    || sourceBounds !== undefined && (!Number.isFinite(sourceBounds.x) || !Number.isFinite(sourceBounds.y))) {
    throw new TypeError("Task window initial geometry is invalid.");
  }
  return sourceBounds === undefined
    ? { width: defaults.width, height: defaults.height }
    : { x: sourceBounds.x + 30, y: sourceBounds.y + 30, width: sourceBounds.width, height: sourceBounds.height };
}
