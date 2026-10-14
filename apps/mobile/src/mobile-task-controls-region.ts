import { keyboardControlRegion, type MobileWindowGeometry } from "./mobile-window-geometry";

/** Translate the current window's usable controls rectangle into the existing detail flow. */
export function mobileTaskControlsRegion(input: {
  readonly geometry: MobileWindowGeometry;
  readonly detailLeft: number;
  readonly detailWidth: number;
  readonly keyboardHeight: number;
  readonly consumedBottomInset: number;
}): { readonly marginLeft: number; readonly marginRight: number; readonly marginBottom: number;
  readonly maxHeight: number; readonly overflow: "hidden" } | undefined {
  const { geometry, detailLeft, detailWidth, keyboardHeight, consumedBottomInset } = input;
  if (geometry.regions.length === 0) return undefined;
  const region = keyboardControlRegion(geometry, keyboardHeight);
  const flowBottom = geometry.height - Math.max(consumedBottomInset, keyboardHeight);
  return {
    marginLeft: Math.max(0, region.x - detailLeft),
    marginRight: Math.max(0, detailLeft + detailWidth - region.x - region.width),
    marginBottom: Math.max(0, flowBottom - region.y - region.height),
    maxHeight: region.height,
    overflow: "hidden"
  };
}
