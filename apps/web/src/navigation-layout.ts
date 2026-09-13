export type NavigationMode = "hidden" | "rail" | "expanded";

export const NAVIGATION_DEFAULT_WIDTH = 260;
export const NAVIGATION_MIN_WIDTH = 180;
export const NAVIGATION_MAX_WIDTH = 480;
export const NAVIGATION_RAIL_WIDTH = 78;
export const NAVIGATION_RAIL_THRESHOLD = 120;
export const NAVIGATION_KEYBOARD_STEP = 10;
export const NAVIGATION_KEYBOARD_LARGE_STEP = 40;

export interface NavigationLayout {
  readonly mode: NavigationMode;
  /** The last expanded width. Rail and hidden modes deliberately preserve it. */
  readonly width: number;
}

export function isNavigationMode(value: unknown): value is NavigationMode {
  return value === "hidden" || value === "rail" || value === "expanded";
}

export function normalizeNavigationWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(NAVIGATION_MAX_WIDTH, Math.max(NAVIGATION_MIN_WIDTH, Math.round(value)))
    : NAVIGATION_DEFAULT_WIDTH;
}

export function navigationVisualWidth(layout: NavigationLayout): number {
  if (layout.mode === "hidden") return 0;
  if (layout.mode === "rail") return NAVIGATION_RAIL_WIDTH;
  return normalizeNavigationWidth(layout.width);
}

export function navigationModeForDragWidth(width: number): Exclude<NavigationMode, "hidden"> {
  return width < NAVIGATION_RAIL_THRESHOLD ? "rail" : "expanded";
}

export function clampNavigationDragWidth(width: number): number {
  return Math.min(NAVIGATION_MAX_WIDTH, Math.max(NAVIGATION_RAIL_WIDTH, width));
}

export function finalizeNavigationDrag(width: number, previousExpandedWidth: number): NavigationLayout {
  if (navigationModeForDragWidth(width) === "rail") {
    return { mode: "rail", width: normalizeNavigationWidth(previousExpandedWidth) };
  }
  return { mode: "expanded", width: normalizeNavigationWidth(width) };
}

export function navigationLayoutForResizeKey(
  layout: NavigationLayout,
  key: string,
  largeStep = false
): NavigationLayout | undefined {
  const width = normalizeNavigationWidth(layout.width);
  const step = largeStep ? NAVIGATION_KEYBOARD_LARGE_STEP : NAVIGATION_KEYBOARD_STEP;
  if (key === "Home") return { mode: "rail", width };
  if (key === "End") return { mode: "expanded", width: NAVIGATION_MAX_WIDTH };
  if (key === "Enter" || key === " ") {
    return { mode: layout.mode === "rail" ? "expanded" : "rail", width };
  }
  if (key === "ArrowRight") {
    return layout.mode === "rail"
      ? { mode: "expanded", width }
      : { mode: "expanded", width: Math.min(NAVIGATION_MAX_WIDTH, width + step) };
  }
  if (key === "ArrowLeft") {
    if (layout.mode === "rail") return { mode: "rail", width };
    const next = width - step;
    return next < NAVIGATION_MIN_WIDTH
      ? { mode: "rail", width }
      : { mode: "expanded", width: next };
  }
  return undefined;
}
