export interface ModelPickerConfigFlyoutRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ModelPickerConfigFlyoutPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly side: "above" | "below";
}

const ROW_OVERLAP = 3;
const ROW_RIGHT_INSET = 30;

/**
 * Keeps the per-model configuration surface inside its visible bounds and
 * chooses the roomier side. When neither side can contain its natural height,
 * that side becomes an independently scrollable viewport.
 */
export function placeModelPickerConfigFlyout(
  anchor: ModelPickerConfigFlyoutRect,
  bounds: ModelPickerConfigFlyoutRect,
  preferredWidth: number,
  naturalHeight: number
): ModelPickerConfigFlyoutPlacement {
  const usableWidth = Math.max(1, bounds.right - bounds.left);
  const width = Math.min(Math.max(1, preferredWidth), usableWidth);
  const left = clamp(anchor.right - ROW_RIGHT_INSET - width, bounds.left, bounds.right - width);
  const belowTop = clamp(anchor.bottom - ROW_OVERLAP, bounds.top, bounds.bottom);
  const aboveBottom = clamp(anchor.top + ROW_OVERLAP, bounds.top, bounds.bottom);
  const belowSpace = Math.max(0, bounds.bottom - belowTop);
  const aboveSpace = Math.max(0, aboveBottom - bounds.top);
  const safeNaturalHeight = Math.max(1, naturalHeight);
  const side = belowSpace >= aboveSpace ? "below" : "above";
  const availableHeight = side === "below" ? belowSpace : aboveSpace;
  const maxHeight = Math.max(1, availableHeight);
  const renderedHeight = Math.min(safeNaturalHeight, maxHeight);
  const top = side === "below" ? belowTop : aboveBottom - renderedHeight;
  return { left, top, width, maxHeight, side };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}
