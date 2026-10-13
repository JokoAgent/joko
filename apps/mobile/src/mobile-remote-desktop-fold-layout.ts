import { controlRegion, windowDivision, type MobileLayoutRect, type MobileWindowGeometry } from "./mobile-window-geometry";

/** Native reservations are in window coordinates; a measured child has already consumed outer chrome. */
export function mobileRemoteDesktopLocalGeometry(geometry: MobileWindowGeometry, container: MobileLayoutRect): MobileWindowGeometry | null {
  if (![container.x, container.y, container.width, container.height].every(Number.isFinite)
    || container.x < 0 || container.y < 0 || container.width <= 0 || container.height <= 0
    || container.x + container.width > geometry.width || container.y + container.height > geometry.height) return null;
  const right = container.x + container.width, bottom = container.y + container.height;
  return { ...geometry, width: container.width, height: container.height,
    insets: { top: Math.max(0, geometry.insets.top - container.y), left: Math.max(0, geometry.insets.left - container.x),
      right: Math.max(0, right - geometry.width + geometry.insets.right), bottom: Math.max(0, bottom - geometry.height + geometry.insets.bottom) },
    regions: geometry.regions.flatMap(region => {
      const x = Math.max(container.x, region.x), y = Math.max(container.y, region.y);
      const width = Math.min(right, region.x + region.width) - x, height = Math.min(bottom, region.y + region.height) - y;
      return width > 0 && height > 0 ? [{ kind: region.kind, x: x - container.x, y: y - container.y, width, height }] : [];
    }) };
}

/** Both media layers share this local rectangle; keyboard occlusion never changes the lease. */
export function mobileRemoteDesktopFoldLayout(
  geometry: MobileWindowGeometry, keyboardBottom: number, panelHeight: number, keyboard: boolean
): { readonly media: MobileLayoutRect; readonly controls: MobileLayoutRect } | null {
  const split = windowDivision(geometry);
  if (!split || split.first.width < 160 || split.second.width < 160 || split.first.height < 160 || split.second.height < 160) return null;
  const bottom = geometry.height - Math.max(0, keyboardBottom);
  let controls = controlRegion(geometry);
  controls = { ...controls, height: Math.max(0, Math.min(controls.height, bottom - controls.y)) };
  // When a tall keyboard covers the lower pane, custom controls move above the division.
  if (keyboard && controls.height < 140 && split.axis === "horizontal") {
    controls = { ...split.first, height: Math.max(0, Math.min(split.first.height, bottom - split.first.y)) };
  }
  const panel = keyboard ? Math.min(Math.max(0, panelHeight), controls.height) : 0;
  const panelTop = controls.y + controls.height - panel;
  const overlappingColumns = controls.x < split.first.x + split.first.width && controls.x + controls.width > split.first.x;
  const mediaBottom = keyboard && overlappingColumns ? Math.min(bottom, panelTop) : bottom;
  const media = { ...split.first, height: Math.max(1, Math.min(split.first.height, mediaBottom - split.first.y)) };
  return { media, controls };
}
