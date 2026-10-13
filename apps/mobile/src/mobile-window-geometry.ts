/** Rectangles are local to the observed window container, in points. */
export interface MobileLayoutRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface MobileReservedRegion extends MobileLayoutRect { readonly kind: "division" | "occlusion"; }
export interface MobileWindowGeometry {
  readonly width: number;
  readonly height: number;
  readonly insets: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  readonly regularWidth: boolean;
  readonly regularHeight: boolean;
  readonly barEdge: "none" | "left" | "right";
  readonly regions: readonly MobileReservedRegion[];
  readonly reservedRegionsSupported: boolean;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function parseMobileWindowGeometry(value: unknown): MobileWindowGeometry | undefined {
  if (!exact(value, ["width", "height", "insets", "regularWidth", "regularHeight", "barEdge", "regions", "reservedRegionsSupported"])
    || !nonnegative(value.width) || value.width === 0 || !nonnegative(value.height) || value.height === 0
    || !exact(value.insets, ["top", "right", "bottom", "left"])
    || !Object.values(value.insets).every(nonnegative) || typeof value.regularWidth !== "boolean" || typeof value.regularHeight !== "boolean"
    || !["none", "left", "right"].includes(value.barEdge as string) || !Array.isArray(value.regions)
    || typeof value.reservedRegionsSupported !== "boolean") return undefined;
  const regions: MobileReservedRegion[] = [];
  for (const region of value.regions) {
    if (!exact(region, ["kind", "x", "y", "width", "height"]) || (region.kind !== "division" && region.kind !== "occlusion")
      || ![region.x, region.y, region.width, region.height].every(nonnegative) || region.width === 0 || region.height === 0
      || (region.x as number) + (region.width as number) > value.width || (region.y as number) + (region.height as number) > value.height) return undefined;
    regions.push(Object.freeze({ kind: region.kind, x: region.x as number, y: region.y as number,
      width: region.width as number, height: region.height as number }));
  }
  if (!value.reservedRegionsSupported && (value.barEdge !== "none" || regions.length !== 0)) return undefined;
  return Object.freeze({ width: value.width, height: value.height,
    insets: Object.freeze({ top: value.insets.top as number, right: value.insets.right as number,
      bottom: value.insets.bottom as number, left: value.insets.left as number }),
    regularWidth: value.regularWidth, regularHeight: value.regularHeight,
    barEdge: value.barEdge as MobileWindowGeometry["barEdge"], regions: Object.freeze(regions), reservedRegionsSupported: value.reservedRegionsSupported });
}

export function safeWindowRect(g: MobileWindowGeometry): MobileLayoutRect {
  return { x: g.insets.left, y: g.insets.top, width: Math.max(0, g.width - g.insets.left - g.insets.right),
    height: Math.max(0, g.height - g.insets.top - g.insets.bottom) };
}
/** Only divisions spanning the safe container divide it into usable panes. */
export function windowDivision(g: MobileWindowGeometry): { axis: "vertical" | "horizontal"; first: MobileLayoutRect; second: MobileLayoutRect } | null {
  const safe = safeWindowRect(g);
  for (const r of g.regions) {
    if (r.kind !== "division" || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) continue;
    if (r.height >= safe.height * 0.8 && r.width > 0 && r.x > safe.x && r.x + r.width < safe.x + safe.width) {
      return { axis: "vertical", first: { ...safe, width: r.x - safe.x },
        second: { ...safe, x: r.x + r.width, width: safe.x + safe.width - r.x - r.width } };
    }
    if (r.width >= safe.width * 0.8 && r.height > 0 && r.y > safe.y && r.y + r.height < safe.y + safe.height) {
      return { axis: "horizontal", first: { ...safe, height: r.y - safe.y },
        second: { ...safe, y: r.y + r.height, height: safe.y + safe.height - r.y - r.height } };
    }
  }
  return null;
}
export function controlRegion(g: MobileWindowGeometry): MobileLayoutRect {
  return avoidReservedRegions(windowDivision(g)?.second ?? safeWindowRect(g), g.regions.filter(r => r.kind === "occlusion"));
}
/** Fit the whole control group inside the largest remaining rectangle. */
export function avoidReservedRegions(initial: MobileLayoutRect, regions: readonly MobileLayoutRect[]): MobileLayoutRect {
  let area = initial;
  for (const r of regions) {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) continue;
    const right = area.x + area.width, bottom = area.y + area.height;
    if (r.x >= right || r.y >= bottom || r.x + r.width <= area.x || r.y + r.height <= area.y) continue;
    const candidates: MobileLayoutRect[] = [
      { ...area, height: Math.max(0, r.y - area.y) },
      { ...area, y: r.y + r.height, height: Math.max(0, bottom - r.y - r.height) },
      { ...area, width: Math.max(0, r.x - area.x) },
      { ...area, x: r.x + r.width, width: Math.max(0, right - r.x - r.width) }
    ];
    area = candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
  }
  return area;
}
/** Avoid applying keyboard padding twice when the lower pane is covered. */
export function keyboardControlRegion(g: MobileWindowGeometry, keyboardBottom: number): MobileLayoutRect {
  const bottom = g.height - Math.max(0, keyboardBottom);
  const clip = (r: MobileLayoutRect) => ({ ...r, height: Math.max(0, Math.min(r.height, bottom - r.y)) });
  const controls = clip(controlRegion(g)), split = windowDivision(g);
  if (controls.height >= 140 || split?.axis !== "horizontal") return controls;
  const upper = controlRegion({ ...g, insets: { ...g.insets, bottom: g.height - split.first.y - split.first.height },
    regions: g.regions.filter(r => r.kind !== "division") });
  const alternative = clip(upper);
  return alternative.height > controls.height ? alternative : controls;
}
