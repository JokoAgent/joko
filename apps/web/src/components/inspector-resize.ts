export const INSPECTOR_DEFAULT_RATIO = 0.5;
export const INSPECTOR_MIN_RATIO = 0.1;
export const INSPECTOR_MAX_RATIO = 0.9;
export const INSPECTOR_MIN_WIDTH = 280;
export const SESSION_MAIN_MIN_WIDTH = 400;

export type InspectorSide = "left" | "right";

export function normalizeInspectorRatio(value: unknown): number {
  if (value === null || value === undefined || value === "") return INSPECTOR_DEFAULT_RATIO;
  const ratio = typeof value === "number" ? value : Number(value);
  return Number.isFinite(ratio)
    ? Math.min(INSPECTOR_MAX_RATIO, Math.max(INSPECTOR_MIN_RATIO, ratio))
    : INSPECTOR_DEFAULT_RATIO;
}

export function inspectorWidthForRatio(availableWidth: number, ratio: number): number {
  const available = Math.max(0, Math.round(availableWidth));
  const maximum = Math.max(0, available - SESSION_MAIN_MIN_WIDTH);
  if (maximum <= INSPECTOR_MIN_WIDTH) return maximum;
  return Math.round(Math.min(maximum, Math.max(INSPECTOR_MIN_WIDTH, available * normalizeInspectorRatio(ratio))));
}

export function inspectorRatioForWidth(availableWidth: number, width: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return INSPECTOR_DEFAULT_RATIO;
  return normalizeInspectorRatio(width / availableWidth);
}

export function inspectorPointerWidth(anchor: number, clientX: number, side: InspectorSide): number {
  return side === "right" ? anchor - clientX : clientX - anchor;
}

export function inspectorResizeDeltaForKey(
  side: InspectorSide,
  key: "ArrowLeft" | "ArrowRight",
  largeStep = false
): number {
  const step = largeStep ? 64 : 16;
  if (side === "right") return key === "ArrowLeft" ? step : -step;
  return key === "ArrowRight" ? step : -step;
}
